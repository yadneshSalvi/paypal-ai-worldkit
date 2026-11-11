import { useId } from "react";
import type { DeviceProfile, KitRevision } from "../../packages/contracts";
import { DeviceArt } from "./device-art";

const colors = { audio: "#416f9e", video: "#9478ac", data: "#408c83", power: "#b79858" };
const positions: Record<string, [number, number]> = { "voice-1": [7, 17], "voice-2": [7, 59], audio: [33, 28], camera: [7, 80], capture: [35, 79], hub: [60, 62], host: [84, 22], monitor: [63, 8], power: [85, 80], storage: [35, 61], attenuator: [35, 58] };

/** A composed explanation of the actual graph, with honest labelled port rails.
 * It deliberately does not represent physical jack coordinates or geometry. */
export function SystemDiorama({ kit, profiles, large = false }: { kit: KitRevision; profiles: DeviceProfile[]; large?: boolean }) {
  const id = useId().replaceAll(":", "");
  const visible = kit.components.filter(component => !component.role.startsWith("cable:") && !["power", "storage"].includes(component.role) && (!component.role.startsWith("voice-") || ["voice-1", "voice-2"].includes(component.role)));
  const location = (role: string) => {
    if (kit.templateId === "T4" && role === "camera") return [57, 81];
    if (kit.templateId === "T4" && role === "capture") return [83, 82];
    if (kit.templateId === "T4" && role === "hub") return [83, 57];
    if (kit.templateId === "T4" && role === "attenuator") return [34, 73];
    if (role === "camera") return [8, 83];
    if (role === "voice-2") return [7, 47];
    return positions[role] ?? [50, 50];
  };
  const points = new Map(visible.map(component => [component.id, location(component.role)]));
  const audio = visible.find(component => component.role === "audio"), audioProfile = profiles.find(profile => profile.id === audio?.profileId);
  const tracks = kit.goal.requirements.find(requirement => requirement.kind === "isolated_tracks")?.target ?? 2;
  return <figure className={`system-diorama ${large ? "large" : ""} architecture-${kit.templateId}`} aria-label={`${kit.templateId}: ${kit.templateId === "T1" ? "record on the host" : kit.templateId === "T4" ? "isolated recorder with camera audio feed" : kit.templateId === "T3" ? "mixer recording and stream" : "onboard recording and separate stream"}`}>
    <div className="system-desk-plane"/>
    <svg className="system-diorama-wires" viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true"><defs><pattern id={`dots-${id}`} width="3" height="3" patternUnits="userSpaceOnUse"><circle cx=".2" cy=".2" r=".13" fill="#849284" opacity=".35"/></pattern></defs><rect x="0" y="0" width="100" height="100" fill={`url(#dots-${id})`}/>{kit.connections.map(edge => {
      const from = points.get(edge.from.componentId), to = points.get(edge.to.componentId); if (!from || !to) return null;
      const x1 = from[0]! + 6, y1 = from[1]! + 3, x2 = to[0]! - 5, y2 = to[1]! + 3;
      const curve = Math.max(8, Math.abs(x2 - x1) * .45);
      return <path key={edge.id} d={`M${x1},${y1} C${x1 + curve},${y1 + 8} ${x2 - curve},${y2 + 8} ${x2},${y2}`} fill="none" stroke={colors[edge.signal]} strokeWidth=".55" strokeDasharray={edge.enabled ? undefined : "1.5 1"} vectorEffect="non-scaling-stroke"/>;
    })}</svg>
    {visible.map(component => {
      const device = profiles.find(profile => profile.id === component.profileId); if (!device) return null;
      const [x, y] = points.get(component.id)!;
      const role = component.role.startsWith("voice-") ? component.role === "voice-1" ? "Voice A" : tracks > 2 ? `+ ${tracks - 1} voices` : "Voice B" : component.role === "audio" ? device.kind === "mixer" ? "Mixer + files" : device.kind === "interface" ? "Interface" : "Recorder + files" : component.role === "monitor" ? "Headphones" : component.role === "host" ? kit.templateId === "T1" ? "Host + files" : "Stream host" : component.role === "attenuator" ? "Level converter" : component.role;
      return <div className={`system-mini-device ${component.role === "audio" ? "central" : ""} ${component.owned ? "owned" : ""}`} key={component.id} style={{ left: `${x}%`, top: `${y}%` }}>
        {component.owned && <span className="system-yours">{component.ownershipSource === "sample" ? "Sample owned" : "Already yours"}</span>}
        {device.kind === "mixer" ? <svg viewBox="0 0 160 100" aria-hidden="true" className="system-mixer-art"><ellipse cx="80" cy="91" rx="65" ry="7" fill="#233247" opacity=".08"/><path d="M14 20L35 8h107l6 12v67H14z" fill="#485161"/><rect x="14" y="20" width="134" height="65" rx="7" fill="#354052"/>{Array.from({length:6},(_,index)=><g key={index} transform={`translate(${27+index*17} 29)`}><circle r="3" cx="0" cy="0" fill={index<2 ? "#b5cfbd" : "#a5a6b4"}/><path d="M0 10v31" stroke="#1b2330" strokeWidth="3"/><rect x="-4" y={16+index%3*7} width="8" height="5" rx="1" fill="#d4d5d6"/></g>)}<circle cx="135" cy="35" r="5" fill="#d2c1a2"/></svg> : <DeviceArt kind={device.kind} model={device.model}/>}
        <span className="system-device-role">{role}</span>
      </div>;
    })}
    <figcaption><span>{audioProfile?.shortName ?? "Audio role to confirm"}</span><span>{kit.connections.length} paths · logical diagram</span></figcaption>
  </figure>;
}
