/**
 * Query-depth ceiling, as a graphql-js validation rule.
 *
 * Behind the operation allow-list this is belt-and-braces — production runs
 * only documents from the shared registry, none of which is deep. It exists for
 * the configuration that is NOT production: a developer or a test enabling
 * arbitrary queries, where an unbounded nested selection is a cheap way to make
 * the gateway fan out until it falls over. It is also what still holds if the
 * allow-list is ever loosened by someone who did not read `persisted.ts`.
 */
import {
  Kind,
  type ASTNode,
  type DocumentNode,
  type FragmentDefinitionNode,
  type SelectionSetNode,
  type ValidationContext,
  GraphQLError,
} from "graphql";

/**
 * Depth of the deepest selection path, counting field nesting only.
 *
 * Fragment spreads are followed (a fragment is how you hide depth from a naive
 * counter) but each is entered at most once per path, so a cyclic document —
 * which is invalid, and which this rule may see before the rule that rejects it
 * — terminates instead of recursing forever.
 */
export function selectionDepth(
  selectionSet: SelectionSetNode,
  fragments: Readonly<Record<string, FragmentDefinitionNode>>,
  seenFragments: readonly string[] = [],
): number {
  let deepest = 0;
  for (const selection of selectionSet.selections) {
    if (selection.kind === Kind.FIELD) {
      const inner = selection.selectionSet
        ? selectionDepth(selection.selectionSet, fragments, seenFragments)
        : 0;
      deepest = Math.max(deepest, 1 + inner);
    } else if (selection.kind === Kind.INLINE_FRAGMENT) {
      // An inline fragment is not a level of its own — `... on X { a }` is as
      // deep as `a`.
      deepest = Math.max(deepest, selectionDepth(selection.selectionSet, fragments, seenFragments));
    } else {
      const name = selection.name.value;
      if (seenFragments.includes(name)) continue; // cycle guard
      const fragment = fragments[name];
      if (!fragment) continue; // unknown fragment — another rule reports it
      deepest = Math.max(
        deepest,
        selectionDepth(fragment.selectionSet, fragments, [...seenFragments, name]),
      );
    }
  }
  return deepest;
}

export function documentDepth(document: DocumentNode): number {
  const fragments: Record<string, FragmentDefinitionNode> = {};
  for (const def of document.definitions) {
    if (def.kind === Kind.FRAGMENT_DEFINITION) fragments[def.name.value] = def;
  }
  let deepest = 0;
  for (const def of document.definitions) {
    if (def.kind === Kind.OPERATION_DEFINITION) {
      deepest = Math.max(deepest, selectionDepth(def.selectionSet, fragments));
    }
  }
  return deepest;
}

export function createDepthLimitRule(maxDepth: number) {
  return function DepthLimit(context: ValidationContext) {
    return {
      Document(node: ASTNode) {
        const depth = documentDepth(node as DocumentNode);
        if (depth > maxDepth) {
          context.reportError(
            new GraphQLError(
              `query is nested ${depth} levels deep; the maximum is ${maxDepth}`,
              { extensions: { code: "bad_request" } },
            ),
          );
        }
      },
    };
  };
}
