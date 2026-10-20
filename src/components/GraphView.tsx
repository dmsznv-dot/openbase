import {
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  ReactFlow,
  Controls,
  MarkerType,
  Handle,
  Position,
  useStore,
  type NodeProps,
  type Node,
  type NodeChange,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { Search, Tag, FileText, Pause, Play } from "lucide-react";
import { buildGraph, type Note } from "../core/model";
import { GraphPhysics } from "../core/graphPhysics";

type BrainData = {
  label: string;
  kind: string;
  dim: boolean;
  activate: () => void;
};
const PageNode = memo(function PageNode({ data }: NodeProps<Node<BrainData>>) {
  const zoom = useStore((s) => s.transform[2]);
  return (
    <button
      className={"brain-node " + data.kind + (data.dim ? " dim" : "")}
      onClick={(e) => {
        if (e.detail === 0) {
          e.stopPropagation();
          data.activate();
        }
      }}
    >
      <Handle type="target" position={Position.Top} />
      <div className="brain-symbol">
        {data.kind === "tag" ? <Tag size={15} /> : <FileText size={17} />}
      </div>
      <span
        style={{
          fontSize: (data.kind === "tag" ? 11 : 12) / Math.max(0.5, zoom),
        }}
      >
        {data.label}
      </span>
      <Handle type="source" position={Position.Bottom} />
    </button>
  );
});
const nodeTypes = { brain: PageNode };

type Graph = ReturnType<typeof buildGraph>;
function GraphCanvas({
  graph,
  focused,
  query,
  onFocus,
  onActivate,
  physics,
  topology,
}: {
  graph: Graph;
  focused: string | null;
  query: string;
  physics: boolean;
  topology: string;
  onFocus: (id: string | null) => void;
  onActivate: (id: string) => void;
}) {
  const [simulation] = useState(() => {
    const sim = new GraphPhysics(
      graph.nodes.map((n) => n.id),
      graph.edges,
    );
    // Start from a readable layout, then let the last movement settle visibly.
    for (let i = 0; i < 100; i++) sim.step();
    return sim;
  });
  const [positions, setPositions] = useState(() => simulation.positions());
  const [measurements, setMeasurements] = useState(
    new Map<string, { width: number; height: number }>(),
  );
  const wake = useRef<() => void>(() => {});
  const lastTopology = useRef(topology);
  useLayoutEffect(() => {
    if (lastTopology.current === topology) return;
    lastTopology.current = topology;
    simulation.reconcile(
      graph.nodes.map((n) => n.id),
      graph.edges,
    );
    setPositions(simulation.positions());
    wake.current();
  }, [graph, simulation, topology]);
  useEffect(() => {
    if (!physics) {
      wake.current = () => {};
      return;
    }
    let frame = 0,
      last = 0;
    const tick = (time: number) => {
      frame = 0;
      if (document.hidden) return;
      if (time - last < 1000 / 60) {
        frame = requestAnimationFrame(tick);
        return;
      }
      last = time;
      const moving = simulation.step();
      setPositions(simulation.positions());
      if (moving) frame = requestAnimationFrame(tick);
    };
    const start = () => {
      if (!frame && !document.hidden) frame = requestAnimationFrame(tick);
    };
    wake.current = start;
    const visibility = () => {
      if (document.hidden) {
        cancelAnimationFrame(frame);
        frame = 0;
      } else start();
    };
    document.addEventListener("visibilitychange", visibility);
    start();
    return () => {
      cancelAnimationFrame(frame);
      document.removeEventListener("visibilitychange", visibility);
      wake.current = () => {};
    };
  }, [simulation, physics]);
  const onNodesChange = useCallback(
    (changes: NodeChange[]) => {
      const dimensions = changes.filter(
        (c) => c.type === "dimensions" && c.dimensions,
      );
      if (dimensions.length)
        setMeasurements((previous) => {
          const next = new Map(previous);
          let changed = false;
          for (const c of dimensions) {
            if (c.type !== "dimensions" || !c.dimensions) continue;
            const old = previous.get(c.id);
            if (
              old?.width !== c.dimensions.width ||
              old?.height !== c.dimensions.height
            ) {
              next.set(c.id, c.dimensions);
              changed = true;
            }
          }
          return changed ? next : previous;
        });
      let changed = false;
      for (const change of changes) {
        if (change.type !== "position" || !change.position) continue;
        simulation.hold(change.id, change.position.x, change.position.y);
        if (!change.dragging) simulation.release(change.id);
        changed = true;
      }
      if (changed) {
        setPositions(simulation.positions());
        wake.current();
      }
    },
    [simulation],
  );
  const baseNodes = useMemo(() => {
    const neighbors = new Set(
      focused
        ? [
            focused,
            ...graph.edges
              .filter((e) => e.source === focused || e.target === focused)
              .flatMap((e) => [e.source, e.target]),
          ]
        : [],
    );
    return graph.nodes.map((n) => ({
      id: n.id,
      type: "brain",
      data: {
        label: n.label,
        kind: n.kind,
        activate: () => onActivate(n.id),
        dim:
          (!!query && !n.label.toLowerCase().includes(query.toLowerCase())) ||
          (!!focused && !neighbors.has(n.id)),
      },
    }));
  }, [graph, focused, query, onActivate]);
  const nodes = useMemo(
    () =>
      baseNodes.map((n) => ({
        ...n,
        measured: measurements.get(n.id),
        position: positions.get(n.id) ?? { x: 0, y: 0 },
      })),
    [baseNodes, positions, measurements],
  );
  const edges = useMemo(
    () =>
      graph.edges.map((e) => ({
        ...e,
        type: "straight",
        animated: false,
        style: {
          stroke: e.kind === "tag" ? "var(--graph-tag)" : "var(--graph-link)",
          strokeWidth: e.kind === "tag" ? 1 : 1.4,
          strokeDasharray: e.kind === "tag" ? "4 5" : undefined,
          opacity:
            focused && e.source !== focused && e.target !== focused
              ? 0.12
              : 0.6,
        },
        markerEnd:
          e.kind === "link"
            ? {
                type: MarkerType.ArrowClosed,
                color: "var(--graph-link)",
                width: 12,
                height: 12,
              }
            : undefined,
      })),
    [graph, focused],
  );
  return (
    <ReactFlow
      nodes={nodes}
      edges={edges}
      nodeTypes={nodeTypes}
      fitView
      fitViewOptions={{ padding: 0.35, maxZoom: 1.25 }}
      minZoom={0.08}
      maxZoom={3}
      onNodesChange={onNodesChange}
      nodesDraggable
      nodesConnectable={false}
      nodeDragThreshold={4}
      nodeClickDistance={4}
      deleteKeyCode={null}
      onNodeDragStart={(_, n) => {
        simulation.hold(n.id, n.position.x, n.position.y);
        wake.current();
      }}
      onNodeDragStop={(_, n) => {
        simulation.hold(n.id, n.position.x, n.position.y);
        simulation.release(n.id);
        wake.current();
      }}
      onPaneClick={() => onFocus(null)}
      onNodeClick={(_, n) => onActivate(n.id)}
      onNodeMouseEnter={(_, n) => onFocus(n.id)}
      onNodeMouseLeave={() => onFocus(null)}
      proOptions={{ hideAttribution: false }}
    >
      <Controls showInteractive={false} />
    </ReactFlow>
  );
}

export default function GraphView({
  notes,
  allNotes,
  onOpen,
  onTag,
}: {
  notes: Note[];
  allNotes: Note[];
  onOpen: (n: Note) => void;
  onTag: (tag: string) => void;
}) {
  const [showTags, setShowTags] = useState(true),
    [query, setQuery] = useState("");
  const [focused, setFocused] = useState<string | null>(null);
  const [physics, setPhysics] = useState(
    () => !matchMedia("(prefers-reduced-motion: reduce)").matches,
  );
  useEffect(() => {
    const media = matchMedia("(prefers-reduced-motion: reduce)");
    const change = () => setPhysics(!media.matches);
    media.addEventListener("change", change);
    return () => media.removeEventListener("change", change);
  }, []);
  const graph = useMemo(
    () => buildGraph(notes.slice(0, 500), showTags, allNotes),
    [notes, allNotes, showTags],
  );
  // Polling, search and hover update labels/styles without resetting positions or the viewport.
  const topology = JSON.stringify([
    graph.nodes.map((n) => n.id).sort(),
    graph.edges.map((e) => e.id).sort(),
  ]);
  const activate = useCallback(
    (id: string) => {
      if (id.startsWith("tag:")) onTag(id.slice(4));
      else {
        const n = notes.find((n) => n.id === id);
        if (n) onOpen(n);
      }
    },
    [notes, onOpen, onTag],
  );
  return (
    <div className="graph-container">
      <div className="graph-top">
        <label className="graph-search">
          <Search size={15} />
          <input
            aria-label="Найти узел"
            placeholder="Найти на графе…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </label>
        <div className="row">
          <button
            className="graph-motion quiet-button"
            aria-label={physics ? "Приостановить физику" : "Включить физику"}
            onClick={() => setPhysics((s) => !s)}
          >
            {physics ? <Pause size={14} /> : <Play size={14} />}
            {physics ? "Пауза" : "Физика"}
          </button>
          <label className="row graph-toggle">
            <input
              type="checkbox"
              checked={showTags}
              onChange={(e) => setShowTags(e.target.checked)}
            />
            Узлы тегов
          </label>
        </div>
      </div>
      <GraphCanvas
        topology={topology}
        graph={graph}
        focused={focused}
        query={query}
        physics={physics}
        onFocus={setFocused}
        onActivate={activate}
      />
      <div className="graph-legend">
        <span>
          <i className="legend-line" />
          Ссылка страницы
        </span>
        <span>
          <i className="legend-line dashed" />
          Общий тег
        </span>
        <span>
          {notes.length} страниц ·{" "}
          {graph.edges.filter((e) => e.kind === "link").length} ссылок
        </span>
        <span className="graph-drag-hint">
          Тяните узлы, чтобы перемещать связи
        </span>
      </div>
      {notes.length > 500 ? (
        <div className="graph-limit">
          Показаны первые 500 страниц. Уточните теги, чтобы увидеть нужную часть
          проекта.
        </div>
      ) : null}
    </div>
  );
}
