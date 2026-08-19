import { defineConfig } from "vitest/config";

export default defineConfig({
  // graphql-js compares constructor identity across every type it touches
  // ("Cannot use GraphQLNonNull from another module or realm"). Under Node the
  // package's `exports` map yields exactly one instance, but Vitest resolves the
  // CJS build for some importers and the ESM build for others, so the schema
  // built by @graphql-tools ends up incompatible with the executor inside Yoga.
  //
  // Inlining the whole GraphQL stack puts every one of them through the same
  // transform, which collapses them back onto a single module instance. This is
  // a TEST-ONLY concern; the service running under Node never sees it.
  resolve: { dedupe: ["graphql"] },
  test: {
    environment: "node",
    server: {
      deps: {
        inline: [/^graphql$/, /^graphql\//, /@graphql-tools/, /graphql-yoga/, /@envelop/],
      },
    },
  },
});
