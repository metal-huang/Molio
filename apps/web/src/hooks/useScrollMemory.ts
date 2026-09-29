/**
 * 阅读视窗位置记忆 —— 按「文档身份」记住滚动位置，切回时恢复。
 *
 * 背景：小 .md 阅读路径的滚动容器在切换文件时被 React 复用（同位置同元素只换
 * children），`scrollTop` 不归 React 管，于是残留上一篇的位置。重置回顶部能消除
 * 「显示出属于别的文档的坐标」，但会丢掉用户在原文档里的阅读位置 —— 而 KB 里最
 * 常见的动作恰恰是「去别的文档核一下再回来」。
 *
 * 本 hook 采用 restore 语义（VS Code 模型，非 Obsidian 默认）：
 * - 有该文档的位置记录且内容未变 → 恢复到原位；
 * - 首次打开 / 内容已被改写过 → 回顶部（reset 作为退化路径自动生效）。
 *
 * 三个关键实现约束（都不显然，改动时留意）：
 *
 * 1. **位置在滚动时持续写入，不依赖「切走时保存」**。切走那一刻 DOM 已经是新
 *    文档，若等 cleanup 再读 `scrollTop`，读到的可能已被新文档高度 clamp 过的值。
 *
 * 2. **恢复必须等新内容「上屏」，而不是等「数据到手」**。这两件事差着一次渲染：
 *    useKnowledge 不清空 fileContent，而 MdRenderer 拿到新 content 后要经自己的
 *    effect setState 才把新 HTML 写进 DOM。若在数据到手那帧落位，`scrollTo` 会被
 *    容器里**上一篇**的 scrollHeight 截断（`scrollTop` 超界即被浏览器夹到上界）：
 *    上一篇越短截得越狠，短到没有滚动条时直接截成 0 —— 表现就是「切回长文档却
 *    回到顶部」。同理，指纹校验也必须在上屏后做（见约束 3）。故 pending 中转一次，
 *    由调用方用「已上屏内容 === 当前内容」判定 ready。
 *
 * 3. **指纹校验也必须在内容就绪时做，不能在切换瞬间做**。切换瞬间手上那份
 *    fileContent 还是上一篇的指纹，拿它跟新文档的记录比对必然不等 —— 会把「切回
 *    来」一律误判成「内容已变」而错误回顶。故 pending 存的是带指纹的记录本身，
 *    等 ready 时再用「此刻已刷新」的指纹比对。
 *
 * 4. **指纹不进 effect 依赖**。指纹含 mtime，用户保存编辑会改它；若进依赖，每次
 *    保存都会重跑切换逻辑并把视窗顶回顶部。
 *
 * 记忆是进程内的（组件存活期），不做持久化：跨重启恢复的旧位置风险高于收益。
 */

import { useCallback, useEffect, useMemo, useRef } from 'react';
import type { RefObject } from 'react';

interface ScrollMemoryEntry {
  top: number;
  /** 内容指纹（size:modifiedAt）—— 文档被改写过则位置作废。 */
  fp: string;
}

/** 记忆条数上限（LRU）：同会话读过的文档数远超此值时不至于无界增长。 */
const MAX_ENTRIES = 100;

export interface UseScrollMemoryOptions {
  /** 滚动容器（`overflow-y: auto` 的那个元素）。 */
  containerRef: RefObject<HTMLElement | null>;
  /**
   * 文档身份 key（含 pane/vault 前缀，避免同一文档在主格与副格互相覆盖）。
   * null = 当前不是被记忆的阅读路径（如 CM / PDF / 排版模式）——此时 hook 完全
   * 让位，不读不写不动滚动。
   */
  key: string | null;
  /** 内容指纹；null = 未知（不参与记忆）。 */
  fingerprint: string | null;
  /**
   * 新文档内容是否**已经上屏**（DOM 里渲染的就是这一篇）。
   * 注意不是「数据到手」——两者差一次渲染，早了会被上一篇的高度截断（约束 2）。
   */
  ready: boolean;
}

export interface UseScrollMemoryReturn {
  /** 「回到顶部」动作：归零并同步记忆（滚动监听会自动记下 0）。 */
  scrollToTop: () => void;
}

export function useScrollMemory({
  containerRef,
  key,
  fingerprint,
  ready,
}: UseScrollMemoryOptions): UseScrollMemoryReturn {
  const memoryRef = useRef(new Map<string, ScrollMemoryEntry>());
  // 渲染期同步 ref，供滚动回调读取「此刻是哪个文档的哪个版本」。
  const keyRef = useRef<string | null>(key);
  const fpRef = useRef<string | null>(fingerprint);
  const readyRef = useRef<boolean>(ready);
  keyRef.current = key;
  fpRef.current = fingerprint;
  readyRef.current = ready;

  /** 待落位的记录（含指纹，等内容就绪后再校验）；null = 本次切换无记录可恢复。 */
  const pendingRef = useRef<ScrollMemoryEntry | null>(null);

  // 切换文档：有记录先挂起（校验推迟到内容就绪），无记录立刻回顶；
  // 并挂上持续记录位置的滚动监听（不依赖「切走时保存」，见约束 1）。
  useEffect(() => {
    const el = containerRef.current;
    if (!key || !el) {
      pendingRef.current = null;
      return;
    }

    const saved = memoryRef.current.get(key) ?? null;
    pendingRef.current = saved;
    // 无记录：立刻回顶（reset 的退化路径）。有记录则先不动，等 ready 时再落位。
    if (!saved) el.scrollTo({ top: 0 });

    const onScroll = () => {
      // 内容未就绪时容器里还是上一篇：此刻的滚动位置既不属于旧文档（它已经不在
      // 这个位置了）也不属于新文档，记下来只会污染记忆。
      if (!readyRef.current) return;
      const k = keyRef.current;
      const fp = fpRef.current;
      if (!k || fp == null) return;
      const map = memoryRef.current;
      // 先删后写：Map 保持插入序，使淘汰近似 LRU。
      map.delete(k);
      map.set(k, { top: el.scrollTop, fp });
      for (const oldest of map.keys()) {
        if (map.size <= MAX_ENTRIES) break;
        map.delete(oldest);
      }
    };
    el.addEventListener('scroll', onScroll, { passive: true });
    return () => el.removeEventListener('scroll', onScroll);
    // fingerprint 故意不在依赖里（见约束 4）。key 变即「换了文档」。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [containerRef, key]);

  // 新内容落地后落位：此时 fpRef 已是新文档的真实指纹，才谈得上比对。
  useEffect(() => {
    if (!ready || !key) return;
    const el = containerRef.current;
    if (!el) return;
    const entry = pendingRef.current;
    pendingRef.current = null;
    const fp = fpRef.current;
    // 内容未变 → 回到原位；已被改写过 → 旧位置作废，明确回顶（不能什么都不做，
    // 否则会留在上个文档残留的位置上）。
    if (entry && fp != null && fp === entry.fp) el.scrollTo({ top: entry.top });
    else el.scrollTo({ top: 0 });
  }, [containerRef, key, ready]);

  const scrollToTop = useCallback(() => {
    containerRef.current?.scrollTo({ top: 0 });
  }, [containerRef]);

  return useMemo(() => ({ scrollToTop }), [scrollToTop]);
}
