"use client";

import { memo, useCallback, useEffect, useMemo, useState } from "react";
import {
  Background,
  BackgroundVariant,
  Controls,
  Handle,
  MiniMap,
  Position,
  ReactFlow,
  ReactFlowProvider,
  addEdge,
  applyEdgeChanges,
  useNodesState,
  useReactFlow,
  type Connection,
  type Edge,
  type Node,
  type NodeProps,
  type OnEdgesChange,
  type OnNodesChange,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";

export type WorkflowStep = {
  id?: string;
  step_type: string;
  delay_hours: number;
  message_template: string | null;
  position_x?: number | null;
  position_y?: number | null;
};

const H_GAP = 236;
const ROW_Y = 72;

const STEP_LABELS: Record<string, string> = {
  visit_profile: "Visitar perfil",
  connect: "Invitar a conectar",
  send_message: "Enviar mensaje",
  send_message_open_profile: "Mensaje (perfil abierto)",
  follow: "Seguir",
  like_post: "Me gusta en post",
  comment_post: "Comentar post",
  voice_note: "Nota de voz",
  reply_comment: "Responder comentario",
  inmail: "InMail",
  wait: "Espera",
};

const NEEDS_MESSAGE = new Set(["send_message", "send_message_open_profile", "comment_post", "reply_comment", "inmail", "connect"]);

// ─── Nodo de acción ─────────────────────────────────────────────────────────
type CampaignStepRfNode = Node<{ step: WorkflowStep }, "campaignStep">;

const CampaignStepNode = memo(function CampaignStepNode({ data, selected }: NodeProps<CampaignStepRfNode>) {
  const label = STEP_LABELS[data.step.step_type] ?? data.step.step_type;
  return (
    <div
      className={`min-w-[168px] max-w-[220px] rounded-[var(--radius-lg)] border px-3 py-2.5 shadow-[var(--shadow-sm)] ${
        selected
          ? "border-[var(--accent)] bg-[var(--surface)] ring-2 ring-[color-mix(in_srgb,var(--accent)_25%,transparent)]"
          : "border-[var(--border)] bg-[var(--surface)]"
      }`}
    >
      <Handle type="target" position={Position.Left} className="!h-2.5 !w-2.5 !border-0 !bg-[var(--muted)]" />
      <p className="truncate text-xs font-semibold text-[var(--text)]" title={label}>
        {label}
      </p>
      <Handle type="source" position={Position.Right} className="!h-2.5 !w-2.5 !border-0 !bg-[var(--muted)]" />
    </div>
  );
});

// ─── Nodo de espera ──────────────────────────────────────────────────────────
type WaitRfNode = Node<{ step: WorkflowStep }, "waitStep">;

function formatDuration(hours: number): string {
  if (hours < 24) return `${hours}h`;
  const d = Math.floor(hours / 24);
  const h = hours % 24;
  return h > 0 ? `${d}d ${h}h` : `${d}d`;
}

const WaitNode = memo(function WaitNode({ data, selected }: NodeProps<WaitRfNode>) {
  return (
    <div
      className={`min-w-[148px] max-w-[200px] rounded-[var(--radius-lg)] border-2 border-dashed px-3 py-2.5 ${
        selected
          ? "border-amber-400 bg-amber-50/10 ring-2 ring-amber-400/25"
          : "border-amber-300/60 bg-amber-50/5"
      }`}
    >
      <Handle type="target" position={Position.Left} className="!h-2.5 !w-2.5 !border-0 !bg-amber-400/60" />
      <p className="text-xs font-semibold text-amber-600 dark:text-amber-400">
        ⏱ Esperar {formatDuration(data.step.delay_hours)}
      </p>
      <Handle type="source" position={Position.Right} className="!h-2.5 !w-2.5 !border-0 !bg-amber-400/60" />
    </div>
  );
});

const nodeTypes = { campaignStep: CampaignStepNode, waitStep: WaitNode };

// ─── Helpers de aristas y nodos ──────────────────────────────────────────────
function linearEdges(n: number): Edge[] {
  if (n < 2) return [];
  return Array.from({ length: n - 1 }, (_, i) => ({
    id: `e-${i}`,
    source: `step-${i}`,
    target: `step-${i + 1}`,
    type: "smoothstep" as const,
    style: { stroke: "color-mix(in srgb, var(--muted) 45%, transparent)" },
  }));
}

function buildNodesFromSteps(steps: WorkflowStep[]): Node[] {
  return steps.map((step, i) => ({
    id: `step-${i}`,
    type: step.step_type === "wait" ? "waitStep" : "campaignStep",
    position: {
      x: step.position_x ?? i * H_GAP,
      y: step.position_y ?? ROW_Y,
    },
    data: { step: { ...step } },
    draggable: true,
  }));
}

// ─── Props ───────────────────────────────────────────────────────────────────
type InnerProps = {
  steps: WorkflowStep[];
  setSteps: React.Dispatch<React.SetStateAction<WorkflowStep[]>>;
  stepTypes: readonly string[];
  edges: Edge[];
  setEdges: React.Dispatch<React.SetStateAction<Edge[]>>;
};

const WAIT_PRESETS = [
  { label: "1h", hours: 1 },
  { label: "6h", hours: 6 },
  { label: "12h", hours: 12 },
  { label: "24h", hours: 24 },
  { label: "48h", hours: 48 },
  { label: "72h", hours: 72 },
];

// ─── Canvas inner ─────────────────────────────────────────────────────────────
function WorkflowCanvasInner({ steps, setSteps, stepTypes, edges, setEdges }: InnerProps) {
  const { getNodes } = useReactFlow();
  const [nodes, setNodes, onNodesChange] = useNodesState<Node>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);

  useEffect(() => {
    setNodes(buildNodesFromSteps(steps));
  }, [steps, setNodes]);

  const onEdgesChangeWrapped: OnEdgesChange<Edge> = useCallback(
    (changes) => {
      setEdges((eds) => applyEdgeChanges(changes, eds));
    },
    [setEdges]
  );

  const onConnect = useCallback(
    (params: Connection) => {
      setEdges((eds) =>
        addEdge({ ...params, type: "smoothstep", style: { stroke: "color-mix(in srgb, var(--muted) 45%, transparent)" } }, eds)
      );
    },
    [setEdges]
  );

  const selectedIndex = useMemo(() => {
    if (!selectedId?.startsWith("step-")) return null;
    const i = Number.parseInt(selectedId.slice(5), 10);
    return Number.isFinite(i) ? i : null;
  }, [selectedId]);

  const onNodeDragStop = useCallback(() => {
    const all = getNodes();
    const posById = Object.fromEntries(all.map((n) => [n.id, n.position]));
    setSteps((prev) =>
      prev.map((s, i) => {
        const p = posById[`step-${i}`];
        if (!p) return s;
        return { ...s, position_x: p.x, position_y: p.y };
      })
    );
  }, [getNodes, setSteps]);

  const onNodesChangeWrapped: OnNodesChange<Node> = useCallback(
    (changes) => {
      onNodesChange(changes);
    },
    [onNodesChange]
  );

  const onSelectionChange = useCallback(({ nodes: sel }: { nodes: Node[] }) => {
    setSelectedId(sel[0]?.id ?? null);
  }, []);

  const updateSelected = useCallback(
    (patch: Partial<WorkflowStep>) => {
      if (selectedIndex == null) return;
      setSteps((prev) => {
        const next = [...prev];
        next[selectedIndex] = { ...next[selectedIndex], ...patch };
        return next;
      });
    },
    [selectedIndex, setSteps]
  );

  const addStep = useCallback(
    (step_type: string) => {
      let nextLen = 0;
      setSteps((prev) => {
        const i = prev.length;
        const needsMsg = NEEDS_MESSAGE.has(step_type);
        const next = [
          ...prev,
          {
            step_type,
            delay_hours: 0,
            message_template: needsMsg ? "Hola {name}" : null,
            position_x: i * H_GAP,
            position_y: ROW_Y,
          },
        ];
        nextLen = next.length;
        return next;
      });
      setEdges(linearEdges(nextLen));
    },
    [setSteps, setEdges]
  );

  const addWaitStep = useCallback(() => {
    let nextLen = 0;
    setSteps((prev) => {
      const i = prev.length;
      const next = [
        ...prev,
        {
          step_type: "wait",
          delay_hours: 24,
          message_template: null,
          position_x: i * H_GAP,
          position_y: ROW_Y,
        },
      ];
      nextLen = next.length;
      return next;
    });
    setEdges(linearEdges(nextLen));
  }, [setSteps, setEdges]);

  const removeSelected = useCallback(() => {
    if (selectedIndex == null || steps.length <= 1) return;
    let nextLen = 0;
    setSteps((prev) => {
      const next = prev.filter((_, i) => i !== selectedIndex);
      nextLen = next.length;
      return next;
    });
    setEdges(linearEdges(nextLen));
    setSelectedId(null);
  }, [selectedIndex, steps.length, setSteps, setEdges]);

  const selectedStep = selectedIndex != null ? steps[selectedIndex] : null;
  const isWaitSelected = selectedStep?.step_type === "wait";

  return (
    <div className="grid gap-4 lg:grid-cols-[1fr_min(320px,100%)]">
      <div className="card h-[min(560px,calc(100vh-16rem))] min-h-[360px] overflow-hidden bg-[color-mix(in_srgb,var(--surface)_55%,var(--bg))] p-0 shadow-none">
        <ReactFlow
          nodes={nodes}
          edges={edges}
          onNodesChange={onNodesChangeWrapped}
          onEdgesChange={onEdgesChangeWrapped}
          onConnect={onConnect}
          onNodeDragStop={onNodeDragStop}
          onSelectionChange={onSelectionChange}
          nodeTypes={nodeTypes}
          fitView
          fitViewOptions={{ padding: 0.2, maxZoom: 1.1 }}
          minZoom={0.35}
          maxZoom={1.35}
          proOptions={{ hideAttribution: true }}
          className="h-full min-h-[360px] rounded-[var(--radius-lg)]"
          snapToGrid={false}
        >
          <Background variant={BackgroundVariant.Dots} gap={16} size={1} color="color-mix(in srgb, var(--muted) 14%, transparent)" />
          <Controls
            className="!m-2 !rounded-[var(--radius-md)] !border !border-[var(--border)] !bg-[var(--surface)] [&_button]:!fill-[var(--text)]"
            showInteractive={false}
          />
          <MiniMap
            className="!m-2 !rounded-[var(--radius-md)] !border !border-[var(--border)] !bg-[color-mix(in_srgb,var(--surface)_92%,var(--bg))]"
            maskColor="color-mix(in srgb, var(--bg) 55%, transparent)"
            nodeColor={() => "var(--accent)"}
          />
        </ReactFlow>
      </div>

      <div className="card card-pad flex flex-col gap-3">
        <div>
          <p className="text-xs font-semibold uppercase tracking-wide text-[var(--muted)]">Flujo de campaña</p>
          <p className="mt-1 text-[11px] text-[var(--muted)]">
            Las tareas se ejecutan en orden. Añade un nodo de espera entre acciones para pausar el flujo el tiempo indicado.
          </p>
        </div>

        <div className="space-y-2">
          <p className="text-[10px] font-medium uppercase text-[var(--muted)]">Añadir paso</p>
          <div className="flex max-h-32 flex-wrap gap-1.5 overflow-y-auto">
            {stepTypes.map((t) => (
              <button
                key={t}
                type="button"
                className="rounded-[var(--radius-md)] border border-[var(--border)] bg-[color-mix(in_srgb,var(--text)_5%,var(--surface))] px-2 py-1 text-[10px] font-medium text-[var(--text)] transition-colors hover:bg-[color-mix(in_srgb,var(--text)_9%,var(--surface))] focus-visible:outline-none"
                onClick={() => addStep(t)}
              >
                {STEP_LABELS[t] ?? t}
              </button>
            ))}
          </div>
          <button
            type="button"
            className="w-full rounded-[var(--radius-md)] border-2 border-dashed border-amber-300/70 bg-amber-50/5 px-2 py-1.5 text-[10px] font-semibold text-amber-600 transition-colors hover:bg-amber-50/10 dark:text-amber-400 focus-visible:outline-none"
            onClick={addWaitStep}
          >
            ⏱ Añadir espera
          </button>
        </div>

        {selectedStep ? (
          <div className="space-y-2 border-t border-[var(--border)] pt-3">
            <p className="text-xs font-medium text-[var(--text)]">
              {isWaitSelected ? "Nodo de espera" : "Paso seleccionado"}
            </p>

            {isWaitSelected ? (
              <>
                <label className="block text-[10px] text-[var(--muted)]">
                  Duración (horas)
                  <input
                    type="number"
                    min={0}
                    className="input-field mt-0.5 min-h-[2.5rem] text-sm"
                    value={selectedStep.delay_hours}
                    onChange={(e) => updateSelected({ delay_hours: Math.max(0, Number(e.target.value)) })}
                  />
                </label>
                <div className="flex flex-wrap gap-1">
                  {WAIT_PRESETS.map((p) => (
                    <button
                      key={p.label}
                      type="button"
                      className={`rounded-[var(--radius-sm)] border px-2 py-0.5 text-[10px] font-medium transition-colors focus-visible:outline-none ${
                        selectedStep.delay_hours === p.hours
                          ? "border-amber-400 bg-amber-400/20 text-amber-600 dark:text-amber-400"
                          : "border-[var(--border)] text-[var(--muted)] hover:border-amber-300/60"
                      }`}
                      onClick={() => updateSelected({ delay_hours: p.hours })}
                    >
                      {p.label}
                    </button>
                  ))}
                </div>
              </>
            ) : (
              <>
                <select
                  className="input-field min-h-[2.5rem] py-2 text-sm"
                  value={selectedStep.step_type}
                  onChange={(e) => updateSelected({ step_type: e.target.value })}
                >
                  {stepTypes.map((t) => (
                    <option key={t} value={t}>
                      {STEP_LABELS[t] ?? t}
                    </option>
                  ))}
                </select>
                {NEEDS_MESSAGE.has(selectedStep.step_type) && (
                  <label className="block text-[10px] text-[var(--muted)]">
                    Plantilla ({"{name}"})
                    <input
                      type="text"
                      className="input-field mt-0.5 min-h-[2.5rem] text-xs"
                      value={selectedStep.message_template ?? ""}
                      onChange={(e) => updateSelected({ message_template: e.target.value || null })}
                    />
                  </label>
                )}
              </>
            )}

            <button type="button" className="btn-danger w-full" onClick={removeSelected} disabled={steps.length <= 1}>
              Eliminar
            </button>
          </div>
        ) : (
          <p className="text-xs text-[var(--muted)]">Selecciona un nodo en el lienzo para editarlo.</p>
        )}
      </div>
    </div>
  );
}

export type CampaignWorkflowEditorProps = InnerProps;

export function CampaignWorkflowEditor(props: CampaignWorkflowEditorProps) {
  return (
    <ReactFlowProvider>
      <WorkflowCanvasInner {...props} />
    </ReactFlowProvider>
  );
}

export function defaultLinearEdges(stepCount: number): Edge[] {
  return linearEdges(stepCount);
}
