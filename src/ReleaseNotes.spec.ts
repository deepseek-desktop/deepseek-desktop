import { enableAutoUnmount, flushPromises, mount } from "@vue/test-utils";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import ReleaseNotes from "./ReleaseNotes.vue";
import { openDesktopUpdateLink } from "./desktop";
import { i18n } from "./i18n";
import { releaseNoteUrl, renderReleaseNotes } from "./release-notes";

vi.mock("./desktop", () => ({ openDesktopUpdateLink: vi.fn() }));
enableAutoUnmount(afterEach);

describe("release notes", () => {
  it("preserves safe Atom list numbering without carrying other attributes", () => {
    expect(renderReleaseNotes('<ol start="7" onclick="bad()"><li>Step</li></ol>', "https://example.com", "html"))
      .toBe('<ol start="7"><li>Step</li></ol>');
    expect(renderReleaseNotes('<ol start="7bad"><li>Step</li></ol>', "https://example.com", "html"))
      .toBe('<ol><li>Step</li></ol>');
  });
  beforeEach(() => {
    vi.mocked(openDesktopUpdateLink).mockReset();
    i18n.global.locale.value = "zh-CN";
  });

  it("renders Markdown blocks, nested lists, tables and escaped code", () => {
    const html = renderReleaseNotes([
      "# Release", "", "## Fixes", "", "A **bold** and *emphasized* note with `code`.", "",
      "1. First", "   - Nested", "", "> Quoted", "",
      "| Platform | File |", "| --- | --- |", "| macOS | DMG |", "",
      "```html", "<script>unsafe()</script>", "```"
    ].join("\n"), "https://example.com/releases/tag/v1.0.0");
    const content = document.createElement("div");
    content.innerHTML = html;
    expect(content.querySelector("h1")?.textContent).toBe("Release");
    expect(content.querySelector("h2")?.textContent).toBe("Fixes");
    expect(content.querySelector("strong")?.textContent).toBe("bold");
    expect(content.querySelector("em")?.textContent).toBe("emphasized");
    expect(content.querySelector("ol ul li")?.textContent).toBe("Nested");
    expect(content.querySelector("blockquote")?.textContent?.trim()).toBe("Quoted");
    expect(content.querySelector("table td")?.textContent).toBe("macOS");
    expect(content.querySelector("pre code")?.textContent).toContain("<script>unsafe()</script>");
    expect(content.querySelector("script")).toBeNull();
  });

  it("does not inject HTML, remote images, styles or executable links", () => {
    const html = renderReleaseNotes([
      '<img src="https://tracker.example/pixel" onerror="alert(1)">',
      '<svg onload="alert(1)"></svg><iframe srcdoc="bad"></iframe><style>body{display:none}</style>',
      '<script>window.bad=true</script>', "", "![tracking](https://tracker.example/image.png)", "",
      "[bad](javascript:alert%281%29)", "[encoded](jav&#x61;script:alert%281%29)",
      "[file](file:///etc/passwd)", "[data](data:text/html,test)",
      "[credentials](https://user:password@example.com)",
      '[safe](https://example.com/?q=%22onmouseover%3D%22bad)'
    ].join("\n"), "https://example.com/release");
    const content = document.createElement("div");
    content.innerHTML = html;
    expect(content.querySelector("script,img,svg,iframe,style,[onerror],[onload],[onmouseover]")).toBeNull();
    const links = [...content.querySelectorAll("a")];
    expect(links.some(link => link.textContent === "safe")).toBe(true);
    expect(links.every(link => releaseNoteUrl(link.href) !== null)).toBe(true);
    expect(links.some(link => ["bad", "encoded", "file", "data", "credentials"].includes(link.textContent || ""))).toBe(false);
    expect(content.querySelector("a")?.getAttribute("rel")).toBe("noopener noreferrer");
    expect(content.textContent).toContain("tracking");
  });

  it("resolves relative Markdown links against the release page", () => {
    const html = renderReleaseNotes("[Download](/owner/repo/releases/download/v1.0.0/app.dmg)", "https://github.com/owner/repo/releases/tag/v1.0.0");
    expect(html).toContain('href="https://github.com/owner/repo/releases/download/v1.0.0/app.dmg"');
    expect(releaseNoteUrl("https://example.com/notes")).toBe("https://example.com/notes");
    for (const value of ["invalid", "javascript:alert(1)", "file:///tmp/app", "data:text/html,hi", "https://user@example.com/"]) {
      expect(releaseNoteUrl(value)).toBeNull();
    }
  });

  it("preserves Atom formatting without inserting publisher HTML or attributes", () => {
    const source = `<div class="markdown-body"><h1 id="location">Release &amp; fixes</h1>
      <p><strong>Harness</strong> <code>&lt;script&gt;</code></p><ul><li>First</li></ul>
      <table style="position:fixed"><tr><td>macOS</td></tr></table>
      <a href="/downloads/app.dmg" onclick="bad()">Download</a>
      <img src="https://tracker.example/pixel" alt="Image text" onerror="bad()">
      <script>bad()</script><iframe src="https://tracker.example/frame"></iframe>
      <svg><a href="https://tracker.example">SVG link</a></svg>
      <math><mtext><table><mglyph><style><!--</style><img title="--><img src=x onerror=bad()>"></math>
      <form><input autofocus><button>Submit</button></form>
      <a href="java&#x73;cript:bad()">unsafe</a><a href="file:///etc/passwd">file</a>
      <a href="https://user:password@example.com">credentials</a></div>`;
    const content = document.createElement("div");
    content.innerHTML = renderReleaseNotes(source, "https://example.com/releases/tag/v1.0.0", "html");
    expect(content.querySelector("h1")?.textContent).toBe("Release & fixes");
    expect(content.querySelector("ul li")?.textContent).toBe("First");
    expect(content.querySelector(".update-notes-table td")?.textContent).toBe("macOS");
    expect(content.querySelector("code")?.textContent).toBe("<script>");
    expect(content.querySelector("script,style,iframe,svg,math,img,input,form,[id],[style],[onclick],[onerror]")).toBeNull();
    expect([...content.querySelectorAll("a")].map(link => link.href)).toEqual(["https://example.com/downloads/app.dmg"]);
    expect(content.textContent).toContain("Image text");
  });

  it("uses the same external-link action for Atom notes", async () => {
    const wrapper = mount(ReleaseNotes, {
      props: { notes: '<p><a href="https://example.com/notes"><b>Details</b></a></p>', format: "html", releaseTag: "v1.0.0" },
      global: { plugins: [i18n] }
    });
    await wrapper.get("b").trigger("click");
    expect(openDesktopUpdateLink).toHaveBeenCalledWith("https://example.com/notes");
  });

  it("opens clicked and middle-clicked links externally without navigating the Shell", async () => {
    const wrapper = mount(ReleaseNotes, {
      props: { notes: "[**Details**](https://example.com/notes)", releaseTag: "v1.0.0" },
      global: { plugins: [i18n] }
    });
    const click = new MouseEvent("click", { bubbles: true, cancelable: true });
    wrapper.get("strong").element.dispatchEvent(click);
    await flushPromises();
    expect(click.defaultPrevented).toBe(true);
    expect(openDesktopUpdateLink).toHaveBeenCalledWith("https://example.com/notes");
    await wrapper.get("a").trigger("auxclick", { button: 1 });
    expect(openDesktopUpdateLink).toHaveBeenCalledTimes(2);
    await wrapper.get("a").trigger("auxclick", { button: 2 });
    expect(openDesktopUpdateLink).toHaveBeenCalledTimes(2);
  });

  it("shows a localized error inside the notes when opening fails", async () => {
    vi.mocked(openDesktopUpdateLink).mockRejectedValue(new Error("browser unavailable"));
    const wrapper = mount(ReleaseNotes, {
      props: { notes: "[Details](https://example.com/notes)", releaseTag: "v1.0.0" },
      global: { plugins: [i18n] }
    });
    await wrapper.get("a").trigger("click");
    await flushPromises();
    expect(wrapper.get('[role="alert"]').text()).toBe("链接无法打开，请重试。");
    await wrapper.setProps({ notes: "New notes" });
    expect(wrapper.find('[role="alert"]').exists()).toBe(false);
  });
});
