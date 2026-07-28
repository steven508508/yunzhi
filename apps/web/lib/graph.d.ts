/** 型別宣告。實作在 graph.mjs——純圖論，沒有相依，所以測得動。 */
export declare function findCycle(
  edges: Map<string, string[]>,
  kpId: string,
  prereqKpId: string,
): string[] | null;
export declare function topoSort(
  nodes: string[],
  edges: Map<string, string[]>,
): string[] | null;
export declare function allCycles(edges: Map<string, string[]>): string[][];
