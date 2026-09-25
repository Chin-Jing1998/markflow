'use strict';
/**
 * 耗时断言的上限系数（测试辅助）：绝对上限在 CI 上乘以 4，本机保持原值
 *
 * 只在 CI 上放宽：各耗时用例的绝对上限按本机（Apple M5 Pro 18 核）实测标定，与改写前后两种实现的耗时之间各留
 * 约 5 倍以上余量，CI 的减速足以吃掉这份余量。2026-09-19 至 09-25 共 42 轮 CI（三平台各 43 个测试 job）中，
 * DOM 类耗时用例的计时区间比本机全量并行运行时中位慢 3.6–5.6 倍、最大慢 5.6–8.9 倍；ubuntu 与 Windows 同级，
 * 并非 Windows 独有，macOS 中位较快但也有离群值。同一 job 内先后执行的两条同类用例，耗时之比在本机约 1.5，在
 * CI 上为 0.74–2.74，可见另有与并行测试文件争抢造成的瞬时波动。2026-09-23，test/web-noise.test.js 的噪声清洗
 * 用例在 Windows 上实测 1533.2 ms，已超出 1500 ms 上限。
 *
 * 取 4：乘以 4 之后，接入本系数的各断言在 CI 上的余量（有效上限 ÷ 三平台上计时区间的估计最大值）不小于 3.9 倍，
 * 接近本机标定时的约 5 倍；最紧的一条即上述噪声清洗用例。
 *
 * 本机保持 1 倍：本机上限不变，以改写之前的实现复跑（负向复跑）时的检出力与原设计一致。
 *
 * 只认 GitHub Actions 在三个平台上都设置的 CI=true；未设置或取其他值（如 1、false）时一律按本机处理。
 */
const BUDGET_FACTOR = process.env.CI === 'true' ? 4 : 1;

/** 耗时断言的有效上限（毫秒）：本机标定的上限乘以 BUDGET_FACTOR */
const budgetMs = (baseMs) => baseMs * BUDGET_FACTOR;

module.exports = { BUDGET_FACTOR, budgetMs };
