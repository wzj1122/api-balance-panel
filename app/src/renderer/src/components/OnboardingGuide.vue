<script setup lang="ts">
import { ref } from 'vue'

defineProps<{ open: boolean }>()
const emit = defineEmits<{
  (e: 'close'): void
  (e: 'add-account'): void
  (e: 'demo'): void
}>()

const step = ref(0)

const STEPS = [
  {
    title: '欢迎使用 API 余额面板',
    desc: '一个纯本地的多平台余额监控工具：定时刷新各平台余额、低余额与异常提醒、每日用量统计、API Key 整理、接口可用性监控。所有密钥只保存在你自己的电脑上（本机加密），请求直连各平台，不经任何中转上报。'
  },
  {
    title: '两种方式开始',
    desc: '① 添加你自己的账号（DeepSeek、小米 MiMo、MiniMax、智谱、硅基流动、阿里云百炼、New API 中转站、自定义）；② 或者先点「先看演示模式」体验完整功能——示例数据只存在内存里，不会写入你的配置、也不会发起请求。小提示：用 API Key 建的账号会自动同步出现在「Key 管理」里。'
  },
  {
    title: '主要功能一览',
    desc: '概览：余额卡片（按类型分组、可折叠）+ 余额耗尽预估；每日使用状况：近 7 天消耗柱状图 + 近 30 天消耗日历（点某天看当日明细）；平台用量：按平台汇总与对比；Key 管理：打标签分类、一键复制成 .env / JSON / curl、克隆、批量操作、安全审计，并能对接口做真实可用性监控；使用报告：日报/周报/月报 + 分享卡片。'
  },
  {
    title: '提醒、日志与个性化',
    desc: '「设置」里可配置每日预算、余额骤降与接口连续失败阈值；「运行日志」记录全部运行情况（已自动脱敏，可一键导出排查问题）；「主题外观」提供 12 套设计师主题、自定义背景图与液态玻璃效果；「设置 → 数据」可导出/导入配置备份。'
  }
]

function next() {
  if (step.value < STEPS.length - 1) step.value += 1
  else emit('close')
}

function prev() {
  if (step.value > 0) step.value -= 1
}
</script>

<template>
  <Transition name="guide">
    <div v-if="open" class="guide-mask">
      <div class="guide-card">
        <div class="guide-badge">新手引导 · {{ step + 1 }} / {{ STEPS.length }}</div>
        <h2 class="guide-title">{{ STEPS[step].title }}</h2>
        <p class="guide-desc">{{ STEPS[step].desc }}</p>

        <div class="guide-dots">
          <span v-for="(s, i) in STEPS" :key="i" class="gdot" :class="{ on: i === step }"></span>
        </div>

        <div class="guide-actions">
          <button class="btn ghost" type="button" @click="emit('close')">跳过</button>
          <span class="spacer"></span>
          <button v-if="step > 0" class="btn ghost" type="button" @click="prev">上一步</button>
          <button v-if="step === 1" class="btn ghost" type="button" @click="emit('demo')">先看演示模式</button>
          <button v-if="step === 1" class="btn primary" type="button" @click="emit('add-account')">添加第一个账号</button>
          <button v-else class="btn primary" type="button" @click="next">
            {{ step === STEPS.length - 1 ? '开始使用' : '下一步' }}
          </button>
        </div>
      </div>
    </div>
  </Transition>
</template>

<style scoped>
.guide-mask {
  position: fixed;
  inset: 0;
  z-index: 200;
  background: rgba(3, 5, 9, 0.66);
  backdrop-filter: blur(3px);
  display: flex;
  align-items: center;
  justify-content: center;
}

.guide-card {
  width: min(560px, 92vw);
  background: var(--modal-bg);
  border: 1px solid var(--line-strong);
  border-radius: 18px;
  box-shadow: var(--shadow);
  padding: 26px 30px 22px;
}

.guide-badge {
  display: inline-block;
  font-size: 11px;
  font-weight: 700;
  color: var(--acc);
  background: var(--acc-soft);
  border-radius: 999px;
  padding: 3px 11px;
  letter-spacing: 0.4px;
}

.guide-title {
  font-size: 21px;
  font-weight: 800;
  color: var(--tx-strong);
  margin: 14px 0 10px;
}

.guide-desc {
  font-size: 13.5px;
  line-height: 1.85;
  color: var(--tx2);
  margin: 0;
  min-height: 76px;
}

.guide-dots { display: flex; gap: 6px; margin: 18px 0 16px; }
.gdot { width: 22px; height: 4px; border-radius: 999px; background: var(--track); transition: all var(--dur) ease; }
.gdot.on { background: var(--acc-grad); width: 34px; }

.guide-actions { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.spacer { flex: 1; }

.guide-enter-active, .guide-leave-active { transition: opacity 0.2s ease; }
.guide-enter-from, .guide-leave-to { opacity: 0; }
</style>
