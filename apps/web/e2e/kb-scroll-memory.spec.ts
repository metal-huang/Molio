import { test, expect, type Page } from '@playwright/test';
import { createTempVault, cleanupTempVault, type TempVault } from './helpers/cleanup';
import * as fs from 'fs';
import * as path from 'path';

/**
 * @area kb
 * @priority P1
 *
 * 阅读视窗位置记忆（useScrollMemory）：小 .md 阅读路径按文档身份记住滚动位置，
 * 切回时恢复；首次打开、内容被改写过、或显式「回到顶部」后从顶部开始。
 *
 * 回归的是三类行为：
 *  - 残留：原来滚动容器被 React 复用，切文档后停在上一篇的坐标上（属于别的
 *    文档的位置，纯 bug）；
 *  - 丢位置：只看「回顶」的话，引用式跳转（去别的文档核一下再回来）每次都要
 *    重新找回原文位置；
 *  - 落位被截断：内容上屏是异步的（MdRenderer 在 effect 里 setState），若在
 *    「数据到手」时就落位，会被容器里上一篇的 scrollHeight 截断——上一篇越短
 *    截得越狠，短到没有滚动条时直接截成 0，看起来就是「切回长文档却回到顶部」。
 *    后两个用例（点标签 / 前进后退）专门守这条。
 *
 * Prerequisites: `pnpm dev` running (daemon :3100, web :5173).
 */

let vault: TempVault;
let fileA: string;
let fileB: string;
let fileShort: string;

/** 短到没有滚动条的文档 —— 用来暴露「落位被上一篇高度截断」。 */
function shortDoc(title: string, marker: string): string {
  return [`# ${title}`, '', '很短的一段话。', '', marker].join('\n');
}

/** 生成足够撑出滚动条的长文档。 */
function longDoc(title: string, marker: string): string {
  const lines = [`# ${title}`, ''];
  for (let i = 1; i <= 200; i++) {
    lines.push(`段落 ${i}：这是一段用于撑高文档的占位文本，重复多次以确保内容超出视口高度。`);
    lines.push('');
  }
  lines.push(marker);
  return lines.join('\n');
}

function treeItem(page: Page, name: string) {
  return page.locator('.kb-tree-item').filter({ hasText: name });
}

const contentArea = (page: Page) => page.locator('.kb-content-area');
const scrollTopOf = (page: Page) => contentArea(page).evaluate((el) => el.scrollTop);

async function scrollTo(page: Page, top: number) {
  await contentArea(page).evaluate((el, t) => { el.scrollTop = t; }, top);
}

/** 打开文档并等它的正文渲染完（用结尾标记确认拿到的是这一篇）。 */
async function openDoc(page: Page, name: string, marker: string) {
  await treeItem(page, name).click();
  await expect(contentArea(page)).toContainText(marker, { timeout: 10_000 });
}

test.describe('KB 阅读视窗位置记忆', () => {
  test.beforeAll(async () => {
    vault = await createTempVault('e2e-kb-scroll-memory');
    fs.unlinkSync(path.join(vault.path, 'test.md'));
    fileA = path.join(vault.path, 'long-a.md');
    fileB = path.join(vault.path, 'long-b.md');
    fileShort = path.join(vault.path, 'short.md');
    fs.writeFileSync(fileA, longDoc('文档 A', 'A 的结尾标记'));
    fs.writeFileSync(fileB, longDoc('文档 B', 'B 的结尾标记'));
    fs.writeFileSync(fileShort, shortDoc('短文档', 'S 的结尾标记'));
  });

  test.afterAll(async () => { if (vault) await cleanupTempVault(vault); });

  test.beforeEach(async ({ page }) => {
    await page.goto(`http://localhost:5173/knowledge?vault=${vault.id}`);
    await expect(page.locator('.kb-shell')).toBeVisible({ timeout: 5_000 });
    await expect(treeItem(page, 'long-a.md')).toBeVisible({ timeout: 10_000 });
  });

  test('首次打开从顶部开始，切回原文档恢复到原位置', async ({ page }) => {
    // A：滚到中间并确认记住
    await openDoc(page, 'long-a.md', 'A 的结尾标记');
    await scrollTo(page, 600);
    await expect.poll(() => scrollTopOf(page)).toBeGreaterThan(500);
    const aTop = await scrollTopOf(page);

    // B：首次打开 —— 必须从顶部开始，而不是停在 A 的坐标上（残留 bug）
    await openDoc(page, 'long-b.md', 'B 的结尾标记');
    expect(await scrollTopOf(page)).toBe(0);

    // B 也滚到别处，使两者的位置可区分
    await scrollTo(page, 1200);
    await expect.poll(() => scrollTopOf(page)).toBeGreaterThan(1100);

    // 回到 A：恢复 A 自己的位置
    await openDoc(page, 'long-a.md', 'A 的结尾标记');
    await expect.poll(() => scrollTopOf(page)).toBe(aTop);

    // 再回 B：恢复 B 的位置（不是 A 的）
    await openDoc(page, 'long-b.md', 'B 的结尾标记');
    await expect.poll(() => scrollTopOf(page)).toBeGreaterThan(1100);
  });

  test('文档内容被改写后旧位置作废，回到顶部', async ({ page }) => {
    await openDoc(page, 'long-a.md', 'A 的结尾标记');
    await scrollTo(page, 800);
    await expect.poll(() => scrollTopOf(page)).toBeGreaterThan(700);

    // 外部改写 A（AI 回写知识库的真实场景）→ size/mtime 变 → 指纹失效
    fs.appendFileSync(fileA, `\n\n## 追加段落\n\n${'新写入的内容。'.repeat(100)}\n`);

    await openDoc(page, 'long-b.md', 'B 的结尾标记');
    await openDoc(page, 'long-a.md', '追加段落');

    // 内容已变：不留在旧坐标上，从顶部开始（poll：落位发生在内容就绪后的 effect 里）
    await expect.poll(() => scrollTopOf(page)).toBe(0);
  });

  test('上一篇短到没有滚动条时，点标签切回长文档仍恢复原位置', async ({ page }) => {
    await openDoc(page, 'long-a.md', 'A 的结尾标记');
    await scrollTo(page, 4000);
    await expect.poll(() => scrollTopOf(page)).toBeGreaterThan(3900);

    // + 另开一个标签打开短文档 → 两篇同时开着，覆盖「点标签切换」路径
    await page.locator('[data-testid="kb-tab-add"]').click();
    await openDoc(page, 'short.md', 'S 的结尾标记');
    expect(
      await contentArea(page).evaluate((el) => el.scrollHeight - el.clientHeight),
      '前提：短文档必须没有滚动条（否则测不到截断）',
    ).toBe(0);

    // 回到长文档：落位发生在新内容上屏之后，不该被短文档的高度截断到 0
    await page.locator('.kb-wtab').filter({ hasText: 'long-a.md' }).first().click();
    await expect(contentArea(page)).toContainText('A 的结尾标记');
    await expect.poll(() => scrollTopOf(page)).toBeGreaterThan(3900);
  });

  test('上一篇短到没有滚动条时，前进/后退切回长文档仍恢复原位置', async ({ page }) => {
    await openDoc(page, 'long-a.md', 'A 的结尾标记');
    await scrollTo(page, 4000);
    await expect.poll(() => scrollTopOf(page)).toBeGreaterThan(3900);

    // 单标签：打开短文档会回收当前标签，历史里留下 long-a → short
    await openDoc(page, 'short.md', 'S 的结尾标记');
    await page.locator('[data-testid="nav-back"]').click();
    await expect(contentArea(page)).toContainText('A 的结尾标记');
    await expect.poll(() => scrollTopOf(page)).toBeGreaterThan(3900);
  });

  test('「回到顶部」按钮归零并同步记忆', async ({ page }) => {
    await openDoc(page, 'long-a.md', 'A 的结尾标记');
    await scrollTo(page, 700);
    await expect.poll(() => scrollTopOf(page)).toBeGreaterThan(600);

    await page.locator('[data-testid="kb-btn-top"]').click();
    expect(await scrollTopOf(page)).toBe(0);

    // 记忆已随之归零：切走再切回仍从顶部开始（而不是回到点按钮前的位置）
    await openDoc(page, 'long-b.md', 'B 的结尾标记');
    await openDoc(page, 'long-a.md', 'A 的结尾标记');
    await expect.poll(() => scrollTopOf(page)).toBe(0);
  });
});
