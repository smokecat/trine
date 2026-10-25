/**
 * **真渲染**的外链拦截测试（评审 N1）。
 *
 * 为什么必须渲染而不是只测 `safeUrlTransform`：streamdown 的 `urlTransform`
 * 只作用于 `html-url-attributes` 的 `urlAttributes` 表，那张表**不含 `srcset`**。
 * 于是 `<picture><source srcset="http://evil.example/x.png">` 原样渲染，
 * 浏览器按 picture 选源规则真的去请求它——纯函数测试全绿，外连照发
 * （评审用 Playwright 量到了实际 GET）。
 *
 * 所以这里把 `<Markdown>` 整个渲染成 HTML，对**最终字符串**断言
 * 「不含攻击者域名」——管线里不管哪个属性能带 URL 出去，都会在这里露馅。
 * `safeUrlTransform` 的纯函数测试留在 chat-model.test.ts，作为判据的细粒度
 * 说明，但不再是唯一防线。
 */
import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { Markdown } from './Markdown.tsx';
import { FileLinksContext, type FileLinks } from '@/components/files/file-links.ts';

const EVIL = 'evil.example';

function render(text: string): string {
  return renderToStaticMarkup(<Markdown text={text} streaming={false} />);
}

/**
 * 25 条载荷：markdown 与 raw HTML 两条路径 × 能带 URL 出去的各类属性。
 * 命名即是断言的理由——出问题时一眼知道是哪条路径漏了。
 */
const PAYLOADS: ReadonlyArray<[name: string, text: string]> = [
  ['md 图片 http', `![x](http://${EVIL}/a.png)`],
  ['md 图片 https', `![x](https://${EVIL}/a.png)`],
  ['md 图片 协议相对 //evil', `![x](//${EVIL}/a.png)`],
  ['md 图片 大写协议', `![x](HTTPS://${EVIL.toUpperCase()}/a.png)`],
  ['md 图片 前置空白', `![x](  https://${EVIL}/a.png)`],
  ['md 链接 javascript:', `[x](javascript:fetch('https://${EVIL}'))`],
  ['md 链接 vbscript:', `[x](vbscript:msgbox('${EVIL}'))`],
  ['md 链接 data:text/html', `[x](data:text/html;base64,${Buffer.from(EVIL).toString('base64')})`],
  ['md 引用式图片', `![x][r]\n\n[r]: https://${EVIL}/a.png`],
  ['html img src', `<img src="https://${EVIL}/a.png" alt="x">`],
  ['html img src 反斜杠 /\\evil', `<img src="/\\${EVIL}/a.png" alt="x">`],
  ['html img 大写 DATA: 伪装', `<img src="DATA:text/html,<script src=https://${EVIL}/a.js>" alt="x">`],
  ['html img data:text/html', `<img src="data:text/html,<img src=https://${EVIL}/a.png>" alt="x">`],
  ['html img srcset', `<img srcset="https://${EVIL}/a.png 1x" alt="x">`],
  ['html img srcset + src', `<img src="/ok.png" srcset="https://${EVIL}/a.png 2x" alt="x">`],
  [
    'html picture>source srcset（N1）',
    `<picture><source media="(min-width:1px)" srcset="http://${EVIL}/x.png"><img alt="x"></picture>`,
  ],
  [
    'html picture>source type+srcset',
    `<picture><source type="image/webp" srcset="https://${EVIL}/y.webp"><img src="/ok.png" alt="x"></picture>`,
  ],
  [
    'html picture 多 source',
    `<picture><source srcset="https://${EVIL}/1.png"><source srcset="https://${EVIL}/2.png"><img alt="x"></picture>`,
  ],
  ['html source src（audio/video 形态）', `<video><source src="https://${EVIL}/v.mp4"></video>`],
  ['html video poster', `<video poster="https://${EVIL}/p.png"></video>`],
  ['html iframe', `<iframe src="https://${EVIL}/frame"></iframe>`],
  ['html object data', `<object data="https://${EVIL}/o.swf"></object>`],
  ['html input type=image', `<input type="image" src="https://${EVIL}/btn.png">`],
  ['html a javascript:', `<a href="javascript:location='https://${EVIL}'">x</a>`],
  ['html 背景样式 url()', `<div style="background-image:url(https://${EVIL}/bg.png)">x</div>`],
];

describe('Markdown 真渲染：assistant 文本不得让浏览器外连（N1）', () => {
  test.each(PAYLOADS)('%s', (_name, text) => {
    expect(render(text)).not.toContain(EVIL);
  });

  test('载荷清单没被意外清空（防假绿）', () => {
    expect(PAYLOADS.length).toBeGreaterThanOrEqual(25);
  });

  test('正常内容照常渲染：同源相对图片放行', () => {
    // 注：`data:image/` 虽被 `safeUrlTransform` 放行，但 streamdown 自己的
    // `allowedImagePrefixes` 默认只认 http(s)，md 语法里的 data: 图片被它换成
    // [Image blocked] span——不外连，符合意图，这里不强求它显示。
    const html = render('![ok](/icons/a.png)');
    expect(html).toContain('/icons/a.png');
  });

  test('普通 markdown 结构不受影响（source 被禁掉没有连累正文）', () => {
    const html = render('# 标题\n\n**粗**与 `code`\n\n- a\n- b');
    expect(html).toContain('标题');
    expect(html).toContain('data-streamdown="strong"');
    expect(html).toContain('data-streamdown="list-item"');
  });
});

describe('Markdown restricted（扩展详情）：更严的一档', () => {
  const renderRestricted = (text: string): string =>
    renderToStaticMarkup(<Markdown text={text} streaming={false} restricted />);

  test.each(PAYLOADS)('%s', (_name, text) => {
    expect(renderRestricted(text)).not.toContain(EVIL);
  });

  test('同源相对图片也不渲染（会把文本带进请求 URL）', () => {
    const html = renderRestricted('![x](/leak?secret=abc)');
    expect(html).not.toContain('/leak');
    expect(html).not.toContain('<img');
  });

  test('链接只留 https：http 与相对路径不带地址', () => {
    expect(renderRestricted('[a](https://example.com/x)')).toContain('data-streamdown="link"');
    expect(renderRestricted('[a](http://example.com/plain)')).not.toContain('example.com/plain');
    expect(renderRestricted('[a](/relative/path)')).not.toContain('/relative/path');
  });
});

describe('Markdown 文件链接（FileLinksContext）：路径可点，外连拦截不变', () => {
  const links: FileLinks = { open: () => {}, browse: () => {} };
  const renderLinked = (text: string, fileBase?: string): string =>
    renderToStaticMarkup(
      <FileLinksContext.Provider value={links}>
        <Markdown text={text} streaming={false} {...(fileBase === undefined ? {} : { fileBase })} />
      </FileLinksContext.Provider>,
    );

  test.each(PAYLOADS)('聊天：%s', (_name, text) => {
    expect(renderLinked(text)).not.toContain(EVIL);
  });

  test.each(PAYLOADS)('文件预览：%s', (_name, text) => {
    expect(renderLinked(text, '/w/repo/docs/a.md')).not.toContain(EVIL);
  });

  test('行内代码里的路径变成按钮；不像路径的照旧', () => {
    const html = renderLinked('看 `docs/plan.md:12` 和 `src/` 以及 `0.20.0`、`npm i`');
    expect(html).toContain('data-path="docs/plan.md"');
    expect(html).toContain('data-path="src/"');
    expect(html.match(/data-testid="file-link"/g)).toHaveLength(2);
    expect(html).toContain('<code data-streamdown="inline-code"');
  });

  test('相对链接：聊天里相对 cwd，文件里相对该文件目录；http 链接照常新标签打开', () => {
    expect(renderLinked('[方案](docs/plan.md)')).toContain('data-path="docs/plan.md"');
    expect(renderLinked('[设计](../design/x.md#top)', '/w/repo/docs/a.md')).toContain('data-path="/w/repo/design/x.md"');
    const http = renderLinked('[站点](https://example.com/x)');
    expect(http).toContain('href="https://example.com/x"');
    expect(http).toContain('target="_blank"');
    expect(http).not.toContain('file-link');
  });

  test('文件预览里的相对图片不加载，给打开按钮', () => {
    const html = renderLinked('![架构图](./img/arch.png)', '/w/repo/docs/a.md');
    expect(html).not.toContain('<img');
    expect(html).toContain('data-path="/w/repo/docs/img/arch.png"');
  });

  test('没有 provider：不出现文件链接', () => {
    expect(render('`docs/plan.md` [x](docs/a.md)')).not.toContain('file-link');
  });
});
