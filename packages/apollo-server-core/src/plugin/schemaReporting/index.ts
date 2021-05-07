import os from 'os';
import type { InternalApolloServerPlugin } from '../internalPlugin';
import { v4 as uuidv4 } from 'uuid';
import { printSchema, validateSchema, buildSchema } from 'graphql';
import { SchemaReporter } from './schemaReporter';
import createSHA from '../../utils/createSHA';
import { schemaIsFederated } from '../schemaIsFederated';
import { GraphQLService, Unsubscriber } from '../../types';

export interface ApolloServerPluginSchemaReportingOptions {
  /**
   * The schema reporter waits before starting reporting.
   * By default, the report waits some random amount of time between 0 and 10 seconds.
   * A longer interval leads to more staggered starts which means it is less likely
   * multiple servers will get asked to upload the same schema.
   *
   * If this server runs in lambda or in other constrained environments it would be useful
   * to decrease the schema reporting max wait time to be less than default.
   *
   * This number will be the max for the range in ms that the schema reporter will
   * wait before starting to report.
   */
  initialDelayMaxMs?: number;
  /**
   * Override the reported schema that is reported to the Apollo registry. This
   * schema does not go through any normalizations and the string is directly
   * sent to the Apollo registry. This can be useful for comments or other
   * ordering and whitespace changes that get stripped when generating a
   * `GraphQLSchema`.
   *
   * **If you pass this option to this plugin, you should explicitly configure
   * `ApolloServerPluginUsageReporting` and pass the same value to its
   * `overrideReportedSchema` option.** This ensures that the schema ID
   * associated with requests reported by the usage reporting plugin matches the
   * schema ID that this plugin reports. For example:
   *
   * ```js
   * new ApolloServer({
   *   plugins: [
   *     ApolloServerPluginSchemaReporting({overrideReportedSchema: schema}),
   *     ApolloServerPluginUsageReporting({overrideReportedSchema: schema}),
   *   ],
   * })
   * ```
   */
  overrideReportedSchema?: string;
  /**
   * The URL to use for reporting schemas. Primarily for testing and internal
   * Apollo use.
   */
  endpointUrl?: string;
  /**
   * To enable schema reporting for federated graphs, you must pass in your
   * gateway instance. Note that overrideReportedSchema is incompatible with
   * this option, as the schema SDL is given directly by gateway. If you would
   * like to customize the schema SDL reported, please instead set the option
   * experimental_updateSupergraphSdl in your gateway configuration.
   */
  gateway?: GraphQLService;
}

export function ApolloServerPluginSchemaReporting(
  {
    initialDelayMaxMs,
    overrideReportedSchema,
    endpointUrl,
    gateway,
  }: ApolloServerPluginSchemaReportingOptions = Object.create(null),
): InternalApolloServerPlugin {
  const bootId = uuidv4();

  let currentSchemaSdl: string | undefined;
  let currentSchemaReporter: SchemaReporter | undefined;
  let gatewaySchemaChangeUnsubscriber: Unsubscriber | undefined;
  if (gateway) {
    gatewaySchemaChangeUnsubscriber = gateway.onSchemaChange((_, schemaSdl) => {
      currentSchemaSdl = schemaSdl;
      if (currentSchemaReporter) {
        const options = currentSchemaReporter.toOptions();
        currentSchemaReporter.stop();
        const executableSchemaId = computeExecutableSchemaId(schemaSdl);
        currentSchemaReporter = new SchemaReporter({
          ...options,
          schemaSdl,
          serverInfo: {
            ...options.serverInfo,
            executableSchemaId,
          },
        });
        currentSchemaReporter.start();
      }
    });
  }

  return {
    __internal_plugin_id__() {
      return 'SchemaReporting';
    },
    async serverWillStart({ apollo, schema, logger }) {
      const { key, graphId } = apollo;
      if (!key) {
        throw Error(
          'To use ApolloServerPluginSchemaReporting, you must provide an Apollo API ' +
            'key, via the APOLLO_KEY environment variable or via `new ApolloServer({apollo: {key})`',
        );
      }
      if (!graphId) {
        throw Error(
          "To use ApolloServerPluginSchemaReporting, you must provide your graph's ID, " +
            "either by using an API key starting with 'service:',  or by providing it explicitly via " +
            'the APOLLO_GRAPH_ID environment variable or via `new ApolloServer({apollo: {graphId}})`',
        );
      }

      // Ensure a provided override schema can be parsed and validated
      if (overrideReportedSchema) {
        try {
          const validationErrors = validateSchema(
            buildSchema(overrideReportedSchema, { noLocation: true }),
          );
          if (validationErrors.length) {
            throw new Error(
              validationErrors.map((error) => error.message).join('\n'),
            );
          }
        } catch (err) {
          throw new Error(
            'The schema provided to overrideReportedSchema failed to parse or ' +
              `validate: ${err.message}`,
          );
        }
      }

      if (schemaIsFederated(schema)) {
        if (!gateway) {
          throw new Error(
            [
              `To use schema reporting with gateways, you must provide the`,
              `gateway instance in the plugin options.`,
            ].join(' '),
          );
        }
      }

      let executableSchemaSdl: string =
        overrideReportedSchema ?? printSchema(schema);
      if (gateway) {
        if (overrideReportedSchema) {
          throw new Error(
            [
              `The overrideReportedSchema option is incompatible with gateways`,
              `as the schema SDL is given directly by gateway. If you would`,
              `like to customize the schema SDL reported, please instead set`,
              `the option experimental_updateSupergraphSdl in your gateway`,
              `configuration.`,
            ].join(' '),
          );
        }
        if (currentSchemaSdl === undefined) {
          throw new Error(
            [
              `Gateway unexpectedly did not set the SDL prior to Apollo Server`,
              `running the serverWillStart hook.`,
            ].join(' '),
          );
        }
        executableSchemaSdl = currentSchemaSdl;
        // NOTE: It is critical that there is no await between here and the
        // start of the schema reporter. If there is, the currentSchemaSdl
        // might be updated by the gateway, which would result in that update
        // being lost, and the schema reporter would report the wrong schema.
        //
        // We could refactor SchemaReporter to contain this complexity, but
        // when this was tried, this resulted in a fair amount of pain (e.g.
        // due to TS not having nice facilities around late initialization, and
        // due to new field mutability making the SchemaReporter more fragile/
        // harder to reason about).
      }

      const executableSchemaId = computeExecutableSchemaId(executableSchemaSdl);

      if (overrideReportedSchema !== undefined) {
        logger.info(
          'Apollo schema reporting: schema to report has been overridden',
        );
      }
      if (endpointUrl !== undefined) {
        logger.info(
          `Apollo schema reporting: schema reporting URL override: ${endpointUrl}`,
        );
      }

      const serverInfo = {
        bootId,
        graphVariant: apollo.graphVariant,
        // The infra environment in which this edge server is running, e.g. localhost, Kubernetes
        // Length must be <= 256 characters.
        platform: process.env.APOLLO_SERVER_PLATFORM || 'local',
        runtimeVersion: `node ${process.version}`,
        executableSchemaId: executableSchemaId,
        // An identifier used to distinguish the version of the server code such as git or docker sha.
        // Length must be <= 256 charecters
        userVersion: process.env.APOLLO_SERVER_USER_VERSION,
        // "An identifier for the server instance. Length must be <= 256 characters.
        serverId:
          process.env.APOLLO_SERVER_ID || process.env.HOSTNAME || os.hostname(),
        libraryVersion: `apollo-server-core@${
          require('../../../package.json').version
        }`,
      };

      logger.info(
        'Apollo schema reporting starting! See your graph at ' +
          `https://studio.apollographql.com/graph/${encodeURIComponent(
            graphId,
          )}/?variant=${encodeURIComponent(
            apollo.graphVariant,
          )} with server info ${JSON.stringify(serverInfo)}`,
      );

      currentSchemaReporter = new SchemaReporter({
        serverInfo,
        schemaSdl: executableSchemaSdl,
        apiKey: key,
        endpointUrl,
        logger,
        // Jitter the startup between 0 and 10 seconds
        initialReportingDelayInMs: Math.floor(
          Math.random() * (initialDelayMaxMs ?? 10_000),
        ),
        fallbackReportingDelayInMs: 20_000,
      });
      currentSchemaReporter.start();

      return {
        async serverWillStop() {
          if (gatewaySchemaChangeUnsubscriber) {
            gatewaySchemaChangeUnsubscriber();
          }
          currentSchemaReporter?.stop();
        },
      };
    },
  };
}

export function computeExecutableSchemaId(schema: string): string {
  return createSHA('sha256').update(schema).digest('hex');
}
