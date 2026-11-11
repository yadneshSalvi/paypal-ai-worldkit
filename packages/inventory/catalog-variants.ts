/** Conservative catalog gates for the explicitly scoped source corpus. Missing variant detail stays unmatched. */
const rules: Record<string, { require?: RegExp[]; exclude?: RegExp[] }> = {
  "zoom-h4essential": {}, "zoom-h1essential": {}, "zoom-h6essential": {}, "zoom-livetrak-l8": {}, "zoom-f3": {}, "zoom-f6": {},
  "focusrite-2i2-4": { require: [/4th|fourth/i] },
  "zoom-podtrak-p4": { exclude: [/p4\s*next/i] }, "tascam-dr40x": { exclude: [/dr[\s-]*40xp/i] }, "tascam-portacapture-x6": {},
  "rode-rodecaster-duo": {}, "focusrite-vocaster-two": {},
  "shure-sm58-lc": { require: [/sm58[\s-]*lc/i], exclude: [/sm58s|wireless/i] },
  "shure-sm57-lc": { require: [/sm57[\s-]*lc/i] },
  "shure-sm7b": { exclude: [/sm7db/i] }, "shure-mv7x": { exclude: [/\busb\b/i] }, "shure-beta58a": {},
  "at2020-xlr": { require: [/black/i], exclude: [/\busb\b|at2020usb|white/i] }, "at2040-xlr": { require: [/black/i], exclude: [/\busb\b|at2040usb|white/i] },
  "rode-nt1-signature": { require: [/signature/i, /black/i], exclude: [/5th|fifth|usb/i] },
  "rode-podmic": { require: [/black/i], exclude: [/usb|white/i] }, "rode-ntusb-mini": {},
  "apple-ipad-air5": { require: [/5th|fifth|\bm1\b/i, /64\s*gb/i, /wi[\s-]*fi/i], exclude: [/cellular|\b5g\b|\bm2\b|\bm3\b|\bm4\b/i] },
  "apple-ipad10": { require: [/10th|tenth|10\s*gen/i, /64\s*gb/i, /wi[\s-]*fi/i], exclude: [/cellular|\b5g\b|\bair\b|\bpro\b/i] },
  "apple-macbook-air-m2": { require: [/\bm2\b/i, /13\.?6|13\s*inch/i, /8\s*gb/i, /256\s*gb/i], exclude: [/15\s*inch|16\s*gb|512\s*gb|10[\s-]*core\s*gpu/i] },
  "apple-mac-mini-m2": { require: [/\bm2\b/i, /8\s*gb/i, /256\s*gb/i], exclude: [/m2\s*pro|16\s*gb|512\s*gb/i] },
  "microsoft-surface-pro9-intel": { require: [/\bi5\b|core\s*i5/i, /8\s*gb/i, /256\s*gb/i], exclude: [/\bsq3\b|\b5g\b|\bi7\b/i] },
  "raspberry-pi5-8gb": { require: [/8\s*gb/i], exclude: [/starter\s*kit|16\s*gb|4\s*gb|2\s*gb/i] },
  "sony-zve10": { require: [/body/i], exclude: [/zv[\s-]*e10\s*(?:ii|mark\s*2|m2)|lens/i] },
  "sony-zve10-ii": { require: [/body/i], exclude: [/lens/i] },
  "canon-eos-r50": { require: [/body/i], exclude: [/r50\s*v\b|lens/i] }, "panasonic-g100d": { require: [/body/i], exclude: [/lens/i] },
  "elgato-camlink-4k": {}, "elgato-hd60x": {}, "elgato-4kx": {},
  "avermedia-gc311": { require: [/gc311\b/i], exclude: [/gc311g2/i] },
  "blackmagic-atem-mini-pro": { exclude: [/\biso\b|extreme/i] },
  "anker-555-a8383": { require: [/a8383|555/i] }, "caldigit-ts4": {}, "owc-thunderbolt-go": { require: [/owctb4dkg11p/i] },
  "hosa-hmic010": {}, "hosa-gpm103": {}, "hosa-cmp159": {}, "rode-sc4": {}, "rode-sc7": {}, "rode-sc16": {},
  "startech-hdmiadmm3": {}, "startech-usb315cc1m": {}, "startech-usb2cub1m": {},
  "apple-60w-usbc1m": { require: [/mw493zm\/?a/i, /\b1\s*m(?:etre|eter)?\b/i] },
  "sony-mdr7506": {}, "audio-technica-m50x": { require: [/black/i], exclude: [/bt2|bluetooth|wireless/i] },
  "beyerdynamic-dt770-80": { require: [/80\s*(?:ohm|Ω)/i], exclude: [/32\s*(?:ohm|Ω)|250\s*(?:ohm|Ω)|pro\s*x/i] },
  "sennheiser-hd280pro": { require: [/506845/i] },
  "anker-735-a2668": { require: [/a2668|ganprime/i, /\bus\b|\busa\b|united\s*states/i], exclude: [/a2667/i] },
  "anker-737-a2148": { require: [/a2148|ganprime/i, /\bus\b|\busa\b|united\s*states/i] },
  "anker-715-a2663": { require: [/a2663|nano\s*ii/i, /\bus\b|\busa\b|united\s*states/i] },
  "raspberry-pi-27w-psu": { require: [/\bus\b|\busa\b|united\s*states/i, /white/i] },
  "rode-psa1plus": { require: [/psa[\s-]*1\s*\+|psa[\s-]*1\s*plus/i] },
  "km-2109-black": { require: [/21090[\s-]*300[\s-]*55/i] },
};
export function corpusVariantMatches(id: string, text: string): boolean {
  const rule = rules[id];
  return Boolean(rule && (rule.require ?? []).every(pattern => pattern.test(text)) && !(rule.exclude ?? []).some(pattern => pattern.test(text)));
}
export const corpusCatalogRules = Object.keys(rules);
