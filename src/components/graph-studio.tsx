"use client";
import { useEffect, useMemo, useState } from "react";
import { Background, BackgroundVariant, Controls, Handle, Position, ReactFlow, type Node, type NodeProps, type Edge, type OnNodesChange, applyNodeChanges } from "@xyflow/react";
import { Check, LockKeyhole, Maximize2 } from "lucide-react";
import type { Component, DeviceProfile, Workspace } from "../../packages/contracts/index";
import type { Edit } from "../../packages/workbench/index";
import { DeviceArt } from "./device-art";
import "@xyflow/react/dist/style.css";

type DeviceNode = Node<{ component: Component; profile: DeviceProfile; active: boolean; problem: boolean }, "device">;
const colors = { audio: "#4c79d1", video: "#9b80c7", data: "#5e9e9b", power: "#bf9b51" };
function ProductNode({ data }: NodeProps<DeviceNode>) {
  const { component, profile, active, problem } = data;
  const inputs = profile.ports.filter(p => p.direction === "in" || p.direction === "bidirectional"); const outputs = profile.ports.filter(p => p.direction === "out" || p.direction === "bidirectional");
  return <div className={`product-node ${active ? "active" : ""} ${problem ? "problem" : ""}`}>
    <div className="node-label"><span>{component.owned ? <><LockKeyhole size={9}/> YOUR GEAR</> : component.role === "voice-1" ? "VOICE 01" : component.role === "voice-2" ? "VOICE 02" : profile.kind.toUpperCase()}</span><i className={problem ? "problem" : ""}/></div>
    <DeviceArt kind={profile.kind} model={profile.model} color={profile.kind === "interface" ? "#a9504c" : "#34414c"}/>
    <div className="node-caption"><strong>{profile.model}</strong><small>{component.role === "audio" ? profile.kind === "recorder" ? "Separate tracks + USB mix" : profile.kind === "interface" ? "Host recording required" : "Onboard multitrack" : profile.manufacturer === "Unconfirmed" ? "Select an exact model" : profile.manufacturer}</small></div>
    {inputs.map((port, index) => <Handle key={`in-${port.id}`} id={port.id} type="target" position={Position.Left} style={{ top: `${35 + index * Math.min(17, 45 / inputs.length)}%`, background: colors[port.signal] }} isConnectable={false} title={`${port.label} · ${port.connector}`}/>)}
    {outputs.map((port, index) => <Handle key={`out-${port.id}`} id={port.id} type="source" position={Position.Right} style={{ top: `${35 + index * Math.min(17, 45 / outputs.length)}%`, background: colors[port.signal] }} isConnectable={false} title={`${port.label} · ${port.connector}`}/>)}
  </div>;
}
const nodeTypes = { device: ProductNode };
export function GraphStudio({ workspace, selected, onSelect, onConnection, onEdit, busy }: { workspace: Workspace; selected: string | null; onSelect: (id: string) => void; onConnection: (id: string) => void; onEdit: (edit: Edit) => Promise<void>; busy: boolean }) {
  const problematic = useMemo(() => new Set(workspace.certificate.results.filter(r => r.status === "violated").flatMap(r => r.componentIds)), [workspace.certificate]);
  const mapped = useMemo((): DeviceNode[] => workspace.kit.components.map(component => ({ id: component.id, type: "device", position: component.position, ariaLabel: `${workspace.profiles.find(p => p.id === component.profileId)!.model}, ${component.owned ? "sample owned device" : "new equipment candidate"}. Select to inspect ports and evidence.`, data: { component, profile: workspace.profiles.find(p => p.id === component.profileId)!, active: selected === component.id, problem: problematic.has(component.id) } })), [workspace.kit, workspace.profiles, selected, problematic]);
  const [nodes, setNodes] = useState<DeviceNode[]>(mapped);
  useEffect(() => setNodes(mapped), [mapped]);
  const change: OnNodesChange<DeviceNode> = changes => setNodes(current => applyNodeChanges(changes, current));
  const edges: Edge[] = workspace.kit.connections.map(edge => ({ id: edge.id, source: edge.from.componentId, target: edge.to.componentId, sourceHandle: edge.from.portId, targetHandle: edge.to.portId, type: "smoothstep", label: edge.enabled ? edge.protocol === "analog_balanced" ? "XLR" : edge.protocol === "usb_audio" ? "USB audio" : edge.protocol === "uvc" ? "USB video" : edge.protocol === "usb_pd" ? "PD" : edge.protocol === "hdmi_1080p60" ? "HDMI" : edge.protocol === "analog_stereo" ? "Monitor" : "USB-C" : "Disconnected", style: { stroke: edge.enabled ? colors[edge.signal] : "#c46a62", strokeWidth: 2, strokeDasharray: edge.enabled ? undefined : "6 5" }, labelStyle: { fontSize: 10, fill: edge.enabled ? colors[edge.signal] : "#b25349", fontWeight: 500 }, labelBgStyle: { fill: "#fbfaf7", fillOpacity: .94 }, labelBgPadding: [6, 3], labelBgBorderRadius: 4, focusable: true, ariaLabel: `${edge.cable}, ${edge.enabled ? "connected" : "disconnected"}. Select for options.` }));
  return <div className="graph-shell"><div className="graph-toolbar"><span className="eyebrow">YOUR STUDIO, CONNECTED</span><span className="canvas-hint"><Maximize2 size={13}/> Pan, zoom, or select a device</span></div>
    <div className="graph-inner"><ReactFlow<DeviceNode> nodes={nodes} edges={edges} nodeTypes={nodeTypes} onNodesChange={change} onNodeClick={(_, node) => onSelect(node.id)} onEdgeClick={(_, edge) => onConnection(edge.id)} onNodeDragStop={(_, node) => { if (!busy) void onEdit({ kind: "position", componentId: node.id, x: node.position.x, y: node.position.y }); }} nodesDraggable={!busy} nodesConnectable={false} edgesReconnectable={false} fitView fitViewOptions={{ padding: .14 }} minZoom={.35} maxZoom={1.8} panOnScroll selectionOnDrag={false} zoomOnDoubleClick={false} proOptions={{ hideAttribution: false }}>
      <Background variant={BackgroundVariant.Dots} gap={20} size={1} color="#d9dedf"/><Controls showInteractive={false}/>
    </ReactFlow></div><footer className="graph-legend">{Object.entries(colors).map(([key, value]) => <span key={key}><i style={{ background: value }}/>{key[0]!.toUpperCase()+key.slice(1)}</span>)}<span className="graph-revision"><Check size={12}/> Saved revision {workspace.kit.revision}</span></footer>
  </div>;
}
