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

export function renderReleaseNotes(source: string, baseUrl: string): string {
  return markdown.render(source, { baseUrl });
}
