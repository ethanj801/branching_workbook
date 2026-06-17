import { nodeLabel } from "../nodeMapLayout";
import type { TreeNode } from "../tree/types";

type StarredNodeListProps = {
  nodes: TreeNode[];
  currentId: string | null;
  disabled: boolean;
  onSelectNode: (nodeId: string) => void | Promise<void>;
};

export default function StarredNodeList({
  nodes,
  currentId,
  disabled,
  onSelectNode,
}: StarredNodeListProps) {
  if (nodes.length === 0) return null;

  return (
    <section className="bw-tree-starred-quick" aria-label="Starred nodes">
      <div className="bw-tree-starred-quick-head">
        <span>Starred</span>
        <span>{nodes.length.toLocaleString()}</span>
      </div>
      <div className="bw-tree-starred-quick-list">
        {nodes.map((node) => (
          <button
            key={node.id}
            type="button"
            className="bw-tree-starred-quick-item"
            data-current={node.id === currentId}
            data-hidden={node.hidden}
            disabled={disabled}
            title={`Go to ${nodeLabel(node)}`}
            onClick={() => void onSelectNode(node.id)}
          >
            <span aria-hidden="true">★</span>
            <span>{nodeLabel(node)}</span>
          </button>
        ))}
      </div>
    </section>
  );
}
