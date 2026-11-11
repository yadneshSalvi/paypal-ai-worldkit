import { useId } from "react";
import type { PublicRecordPayload } from "../../packages/public-record";

const signalColors = { audio: "#245fca", video: "#7950b3", data: "#1c7979", power: "#916318" };
const fixed: Record<string, [number, number]> = { "voice-1": [18, 40], "voice-2": [18, 195], camera: [18, 390], audio: [270, 94], capture: [270, 390], hub: [520, 242], host: [770, 40], monitor: [770, 390], power: [520, 474] };
const short = (text: string, max = 25) => text.length > max ? `${text.slice(0, max - 1)}…` : text;

/** A schematic uses explicit port rails, never invented physical jack positions. */
export function RecordDiagram({ payload }: { payload: PublicRecordPayload }) {
  const marker = useId().replace(/:/g, "");
  const positions = new Map(payload.devices.map((device, i) => [device.componentId, fixed[device.role] ?? [18 + (i % 4) * 250, 40 + Math.floor(i / 4) * 155] as [number, number]]));
  const height = Math.max(600, ...[...positions.values()].map(([, y]) => y + 135));
  return <figure className="record-diagram"><figcaption><div><span className="record-kicker">THE SAVED CONNECTION MAP</span><h3>Every path has a purpose.</h3></div><span>{payload.connections.filter(edge => edge.enabled).length} enabled · {payload.connections.filter(edge => !edge.enabled).length} disabled</span></figcaption>
    <svg viewBox={`0 0 980 ${height}`} role="img" aria-labelledby={`${marker}-title ${marker}-desc`}><title id={`${marker}-title`}>Schematic of {payload.title}</title><desc id={`${marker}-desc`}>Numbered connections identify the saved assembly steps. Solid paths are enabled. Dashed paths are disabled. This is a logical diagram with labelled device rails, not measured physical port locations. An equivalent connection list follows.</desc><defs><pattern id={`${marker}-grid`} width="20" height="20" patternUnits="userSpaceOnUse"><circle cx="1" cy="1" r=".8" fill="#9aaab9" opacity=".3"/></pattern>{Object.entries(signalColors).map(([signal, color]) => <marker key={signal} id={`${marker}-${signal}`} viewBox="0 0 10 10" refX="8" refY="5" markerWidth="5" markerHeight="5" orient="auto-start-reverse"><path d="M 0 0 L 10 5 L 0 10 z" fill={color}/></marker>)}</defs><rect width="980" height={height} rx="15" fill={`url(#${marker}-grid)`}/>
      {payload.connections.map((edge, index) => {
        const from = positions.get(edge.from.componentId), to = positions.get(edge.to.componentId); if (!from || !to) return null;
        const vertical = from[0] === to[0], forwards = to[0] > from[0];
        const x1 = vertical ? from[0] + 90 : from[0] + (forwards ? 184 : 0), y1 = vertical ? from[1] : from[1] + 49;
        const x2 = vertical ? to[0] + 90 : to[0] + (forwards ? 0 : 184), y2 = vertical ? to[1] + 98 : to[1] + 49;
        const dx = Math.max(48, Math.abs(x2 - x1) / 2), d = vertical ? `M${x1},${y1} C${x1},${y1 - 35} ${x2},${y2 + 35} ${x2},${y2}` : `M${x1},${y1} C${x1 + (forwards ? dx : -dx)},${y1} ${x2 - (forwards ? dx : -dx)},${y2} ${x2},${y2}`;
        const labelX = vertical ? x1 : (x1 + x2) / 2, labelY = (y1 + y2) / 2 + (index % 2 ? 10 : -8);
        return <g key={edge.id} className={`record-wire ${edge.signal} ${edge.enabled ? "enabled" : "disabled"}`}><path d={d} fill="none" stroke={signalColors[edge.signal]} strokeWidth="2.5" strokeDasharray={edge.enabled ? undefined : "7 6"} markerEnd={`url(#${marker}-${edge.signal})`}/><circle cx={labelX} cy={labelY} r="11" fill="#fffdf8" stroke={edge.enabled ? signalColors[edge.signal] : "#555"}/><text x={labelX} y={labelY + 4} fontSize="10" textAnchor="middle" fill="#142a42">{index + 1}</text></g>;
      })}
      {payload.devices.map((device, i) => { const [x, y] = positions.get(device.componentId)!; return <g key={device.componentId} transform={`translate(${x} ${y})`} className="record-node"><rect width="184" height="98" rx="10" fill="#fffdf8" stroke="#9caab6"/><rect x="12" y="13" width="24" height="24" rx="5" fill="#e7eef7"/><text x="24" y="29" fontSize="10" fill="#245fca" textAnchor="middle">{String(i + 1).padStart(2, "0")}</text><text x="45" y="28" fontSize="10" fill="#506174">{device.kind.toUpperCase()}</text><text x="12" y="56" fontSize="14" fill="#142a42" fontWeight="600">{short(device.model, 22)}</text><text x="12" y="77" fontSize="10" fill="#506174">{short(device.manufacturer, 25)} · ×{device.quantity}</text><circle cx="0" cy="49" r="4" fill="#fffdf8" stroke="#657789"/><circle cx="184" cy="49" r="4" fill="#fffdf8" stroke="#657789"/></g>; })}
    </svg><div className="record-legend">{Object.keys(signalColors).map(signal => <span key={signal}><i className={signal}/>{signal}</span>)}<span><i className="disabled"/>disabled path</span></div><p className="record-caption">A logical connection map. Port names and exact modes are listed below; the diagram does not depict physical jack positions.</p>
    <ol className="record-connection-index">{payload.connections.map((edge, i) => { const from = payload.devices.find(d => d.componentId === edge.from.componentId), to = payload.devices.find(d => d.componentId === edge.to.componentId); return <li key={edge.id} id={`connection-${edge.id}`}><span className={`record-path-number ${edge.signal}`}>{i + 1}</span><div><b>{from?.model ?? "Unresolved device"} → {to?.model ?? "Unresolved device"}</b><span>{from?.ports.find(p => p.id === edge.from.portId)?.label ?? "Unresolved port"} → {to?.ports.find(p => p.id === edge.to.portId)?.label ?? "Unresolved port"}</span><small>{edge.signal} · {edge.enabled ? edge.cable : "DISABLED — do not assemble"}</small></div></li>; })}</ol>
  </figure>;
}
