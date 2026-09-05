import MarkdownIt from "markdown-it";

export function releaseNoteUrl(value: string, baseUrl?: string): string | null {
  try {
    const url = new URL(value, baseUrl);
    return ["https:", "http:"].includes(url.protocol) && !url.username && !url.password ? url.href : null;
  } catch {
    return null;
  }
}

const markdown = new MarkdownIt({ html: false, linkify: true });
markdown.validateLink = value => releaseNoteUrl(value, "https://github.com/") !== null;
markdown.renderer.rules.link_open = (tokens, index, options, env, renderer) => {
  const token = tokens[index];
  const baseUrl = typeof env?.baseUrl === "string" ? env.baseUrl : undefined;
  token.attrSet("href", releaseNoteUrl(String(token.attrGet("href") || ""), baseUrl) || "");
  token.attrSet("target", "_blank");
  token.attrSet("rel", "noopener noreferrer");
  return renderer.renderToken(tokens, index, options);
};
// Release text must not load tracking images or execute publisher-provided HTML in the Shell.
markdown.renderer.rules.image = (tokens, index) => markdown.utils.escapeHtml(tokens[index].content);
markdown.renderer.rules.table_open = () => '<div class="update-notes-table" tabindex="0"><table>\n';
markdown.renderer.rules.table_close = () => "</table></div>\n";

const noteElements = new Set([
  "p", "h1", "h2", "h3", "h4", "h5", "h6", "ul", "ol", "li", "blockquote",
  "strong", "b", "em", "i", "s", "del", "pre", "code", "hr", "br",
  "table", "thead", "tbody", "tfoot", "tr", "th", "td"
]);

function renderFeedNotes(source: string, baseUrl: string): string {
  // Template contents stay inert. Rebuild only formatting, never insert publisher DOM or attributes.
  const template = document.createElement("template");
  template.innerHTML = source;
  const escape = markdown.utils.escapeHtml;
  function render(node: Node, depth = 0): string {
    if (node.nodeType === Node.TEXT_NODE) return escape(node.textContent || "");
    if (!(node instanceof Element) || depth > 64) return "";
    const tag = node.localName;
    if (node.namespaceURI !== "http://www.w3.org/1999/xhtml") return "";
    if (tag === "img") return escape(node.getAttribute("alt") || "");
    if (!noteElements.has(tag) && !["a", "div", "span"].includes(tag)) return "";
    const children = Array.from(node.childNodes, child => render(child, depth + 1)).join("");
    if (tag === "div" || tag === "span") return children;
    if (tag === "a") {
      const href = node.getAttribute("href");
      const url = href ? releaseNoteUrl(href, baseUrl) : null;
      return url ? `<a href="${escape(url)}" target="_blank" rel="noopener noreferrer">${children}</a>` : children;
    }
    if (tag === "hr" || tag === "br") return `<${tag}>`;
    if (tag === "ol") {
      const start = node.getAttribute("start") || "";
      const attribute = /^-?\d{1,9}$/u.test(start) ? ` start="${Number(start)}"` : "";
      return `<ol${attribute}>${children}</ol>`;
    }
    const html = `<${tag}>${children}</${tag}>`;
    return tag === "table" ? `<div class="update-notes-table" tabindex="0">${html}</div>` : html;
  }
  return Array.from(template.content.childNodes, node => render(node)).join("");
}

export function renderReleaseNotes(source: string, baseUrl: string, format: "markdown" | "html" = "markdown"): string {
  if (format === "html") return renderFeedNotes(source, baseUrl);
  return markdown.render(source, { baseUrl });
}
