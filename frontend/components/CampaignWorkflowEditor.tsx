"use client";

import { memo, useCallback, useEffect, useMemo, useState } from "react";
import {
  Background,
  BackgroundVariant,
  Controls,
  Handle,
  Position,
  ReactFlow,
  ReactFlowProvider,
  useEdgesState,
  useNodesState,
  useReactFlow,
  type Edge,
  type Node,
  type NodeProps,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";

export type WorkflowStep = {
  id?: string;
  step_type: string;
  delay_hours: number;
  message_template: string | null;
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
};

type CampaignStepRfNode = Node<{ step: WorkflowStep }, "campaignStep">;

const CampaignStepNode = memo(function CampaignStepNode({ data, selected }: NodeProps<CampaignStepRfNode>) {
  const label = STEP_LABELS[data.step.step_type] ?? data.step.step_type;
  return (
    <div
      className={`min-w-[168px] max-w-[200px] rounded-xl border px-3 py-2 shadow-md ${
        selected
          ? "border-[var(--accent)] bg-[var(--surface)] ring-2 ring-[var(--accent)]/25"
          : "border-white/20 bg-[var(--bg)]"
      }`}
    >
      <Handle type="target" position={Position.Left} className="!h-2 !w-2 !border-0 !bg-[var(--muted)]" />
      <p className="truncate text-xs font-semibold text-[var(--text)]" title={label}>
        {label}
      </p>
      <p className="text-[10px] text-[var(--muted)]">Espera {data.step.delay_hours}h</p>
      <Handle type="source" position={Position.Right} className="!h-2 !w-2 !border-0 !bg-[var(--muted)]" />
    </div>
  );
});

const nodeTypes = { campaignStep: CampaignStepNode };

function stepsToNodesAndEdges(steps: WorkflowStep[]): { nodes: Node[]; edges: Edge[] } {
  const nodes: Node[] = steps.map((step, i) => ({
    id: `step-${i}`,
    type: "campaignStep",
    position: { x: i * H_GAP, y: ROW_Y },
    data: { step: { ...step } },
    draggable: true,
  }));
  const edges: Edge[] =
    steps.length < 2
      ? []
      : steps.slice(0, -1).map((_, i) => ({
          id: `e-${i}`,
          source: `step-${i}`,
          target: `step-${i + 1}`,
          type: "smoothstep",
          style: { stroke: "rgba(255,255,255,0.25)" },
        }));
  return { nodes, edges };
}

type InnerProps = {
  steps: WorkflowStep[];
  setSteps: React.Dispatch<React.SetStateAction<WorkflowStep[]>>;
  stepTypes: readonly string[];
};

function WorkflowCanvasInner({ steps, setSteps, stepTypes }: InnerProps) {
  const { getNodes } = useReactFlow();
  const [nodes, setNodes, onNodesChange] = useNodesState<Node>([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);

  useEffect(() => {
    const { nodes: n, edges: e } = stepsToNodesAndEdges(steps);
    setNodes(n);
    setEdges(e);
  }, [steps, setNodes, setEdges]);

  const selectedIndex = useMemo(() => {
    if (!selectedId?.startsWith("step-")) return null;
    const i = Number.parseInt(selectedId.slice(5), 10);
    return Number.isFinite(i) ? i : null;
  }, [selectedId]);

  const onNodeDragStop = useCallback(() => {
    const all = getNodes();
    if (all.length < 2) return;
    const sorted = [...all].sort((a, b) => a.position.x - b.position.x);
    const nextSteps = sorted.map((n) => ({ ...(n.data.step as WorkflowStep) }));
    setSteps(nextSteps);
    setNodes(
      sorted.map((n, i) => ({
        ...n,
        id: `step-${i}`,
        position: { x: i * H_GAP, y: ROW_Y },
      }))
    );
    setEdges(
      nextSteps.length < 2
        ? []
        : nextSteps.slice(0, -1).map((_, i) => ({
            id: `e-${i}`,
            source: `step-${i}`,
            target: `step-${i + 1}`,
            type: "smoothstep",
            style: { stroke: "rgba(255,255,255,0.25)" },
          }))
    );
    setSelectedId(null);
  }, [getNodes, setSteps, setNodes, setEdges]);

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
      setSteps((prev) => [
        ...prev,
        { step_type, delay_hours: 0, message_template: step_type.includes("message") ? "Hola {name}" : "" },
      ]);
    },
    [setSteps]
  );

  const removeSelected = useCallback(() => {
    if (selectedIndex == null || steps.length <= 1) return;
    setSteps((prev) => prev.filter((_, i) => i !== selectedIndex));
    setSelectedId(null);
  }, [selectedIndex, steps.length, setSteps]);

  const selectedStep = selectedIndex != null ? steps[selectedIndex] : null;

  return (
    <div className="grid gap-4 lg:grid-cols-[1fr_min(320px,100%)]">
      <div className="h-[min(480px,calc(100vh-14rem))] min-h-[320px] rounded-xl border border-white/10 bg-black/20">
        <ReactFlow
          nodes={nodes}
          edges={edges}
          onNodesChange={onNodesChange}
          onEdgesChange={onEdgesChange}
          onNodeDragStop={onNodeDragStop}
          onSelectionChange={onSelectionChange}
          nodeTypes={nodeTypes}
          fitView
          fitViewOptions={{ padding: 0.2, maxZoom: 1 }}
          minZoom={0.4}
          maxZoom={1.25}
          proOptions={{ hideAttribution: true }}
          className="rounded-xl"
        >
          <Background variant={BackgroundVariant.Dots} gap={16} size={1} color="rgba(255,255,255,0.08)" />
          <Controls className="!m-2 !border-white/10 !bg-[var(--surface)] [&_button]:!fill-[var(--text)]" showInteractive={false} />
        </ReactFlow>
      </div>

      <div className="flex flex-col gap-3 rounded-xl border border-white/10 bg-[var(--surface)] p-4">
        <div>
          <p className="text-xs font-semibold uppercase tracking-wide text-[var(--muted)]">Secuencia lineal</p>
          <p className="mt-1 text-[11px] text-[var(--muted)]">
            Arrastra los nodos para reordenar. El motor ejecuta los pasos en orden, sin ramas condicionales.
          </p>
        </div>

        <div>
          <p className="mb-2 text-[10px] font-medium uppercase text-[var(--muted)]">Añadir paso</p>
          <div className="flex max-h-36 flex-wrap gap-1.5 overflow-y-auto">
            {stepTypes.map((t) => (
              <button
                key={t}
                type="button"
                className="rounded-lg border border-white/10 bg-black/20 px-2 py-1 text-[10px] hover:bg-white/5"
                onClick={() => addStep(t)}
              >
                {STEP_LABELS[t] ?? t}
              </button>
            ))}
          </div>
        </div>

        {selectedStep ? (
          <div className="space-y-2 border-t border-white/10 pt-3">
            <p className="text-xs font-medium text-[var(--text)]">Paso seleccionado</p>
            <select
              className="w-full rounded-lg border border-white/10 bg-[var(--bg)] px-2 py-1.5 text-sm"
              value={selectedStep.step_type}
              onChange={(e) => updateSelected({ step_type: e.target.value })}
            >
              {stepTypes.map((t) => (
                <option key={t} value={t}>
                  {STEP_LABELS[t] ?? t}
                </option>
              ))}
            </select>
            <label className="block text-[10px] text-[var(--muted)]">
              Espera (horas)
              <input
                type="number"
                className="mt-0.5 w-full rounded-lg border border-white/10 bg-[var(--bg)] px-2 py-1.5 text-sm"
                value={selectedStep.delay_hours}
                onChange={(e) => updateSelected({ delay_hours: Number(e.target.value) })}
              />
            </label>
            <label className="block text-[10px] text-[var(--muted)]">
              Plantilla ({"{name}"})
              <input
                className="mt-0.5 w-full rounded-lg border border-white/10 bg-[var(--bg)] px-2 py-1.5 text-xs"
                value={selectedStep.message_template ?? ""}
                onChange={(e) => updateSelected({ message_template: e.target.value || null })}
              />
            </label>
            <button
              type="button"
              className="w-full rounded-lg border border-red-500/30 py-1.5 text-xs text-red-300/90 hover:bg-red-500/10"
              onClick={removeSelected}
              disabled={steps.length <= 1}
            >
              Eliminar paso
            </button>
          </div>
        ) : (
          <p className="text-xs text-[var(--muted)]">Selecciona un nodo en el canvas para editarlo.</p>
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
