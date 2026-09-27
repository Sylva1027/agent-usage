export function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (character) => {
    const replacements = {
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#39;",
    };
    return replacements[character];
  });
}

export function externalHttpUrl(value) {
  // The control-character range is intentional: URLs containing C0 controls or DEL are rejected before parsing.
  // biome-ignore lint/suspicious/noControlCharactersInRegex: deliberate reject-list for untrusted pricing source URLs
  if (typeof value !== "string" || /[\u0000-\u001f\u007f]/.test(value)) return null;
  try {
    const url = new URL(value);
    return ["http:", "https:"].includes(url.protocol) && url.hostname && !url.username && !url.password ? url : null;
  } catch {
    return null;
  }
}

// These are the only color forms produced by the dashboard palettes.
export function safeChartColor(value) {
  const color = String(value || "");
  return /^#[0-9a-f]{6}$/i.test(color) || /^hsl\(\d+(?:\.\d+)? 70% (?:38|64)%\)$/.test(color) || color === "var(--green)"
    ? color
    : "var(--green)";
}
