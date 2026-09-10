<script setup lang="ts">
import { onMounted, ref } from 'vue'
import type { Settings } from '@shared/types'
import { backgroundData, importBackground, listBackgrounds, removeBackground } from '@renderer/api/ipc'
import InfoTip from './InfoTip.vue'
import SelectMenu from './SelectMenu.vue'

const props = defineProps<{ settings: Settings | null }>()
const emit = defineEmits<{ (e: 'save', patch: Partial<Settings>): void }>()

interface ThemeDef { slug: string; name: string; desc: string }

/** 主题清单：内置 3 个 + 设计师交付的 12 套 */
const THEMES: ThemeDef[] = [
  { slug: 'dark', name: '深色（默认）', desc: '经典深色' },
  { slug: 'light', name: '浅色（默认）', desc: '经典浅色' },
  { slug: 'system', name: '跟随系统', desc: '随系统自动切换' },
  { slug: 'deep-space-dark', name: '深空蓝 · 深', desc: '冷静深邃' },
  { slug: 'deep-space-light', name: '深空蓝 · 浅', desc: '清爽天蓝' },
  { slug: 'fluent-acrylic-dark', name: '亚克力 · 深', desc: '柔光毛玻璃' },
  { slug: 'fluent-acrylic-light', name: '亚克力 · 浅', desc: '通透亚克力' },
  { slug: 'soft-pastel-dark', name: '柔雾紫 · 深', desc: '低饱和雾紫' },
  { slug: 'soft-pastel-light', name: '柔雾紫 · 浅', desc: '温柔紫调' },
  { slug: 'editorial-mono-dark', name: '编辑部 · 深', desc: '墨青衬线感' },
  { slug: 'editorial-mono-light', name: '编辑部 · 浅', desc: '纸张阅读感' },
  { slug: 'scifi-3d-dark', name: '科幻立体 · 深', desc: '霓虹立体' },
  { slug: 'scifi-3d-light', name: '科幻立体 · 浅', desc: '明亮科技' },
  { slug: 'cute-bluepink-dark', name: '蓝粉糖果 · 深', desc: '甜酷夜光' },
  { slug: 'cute-bluepink-light', name: '蓝粉糖果 · 浅', desc: '轻甜蓝粉' }
]

const files = ref<{ name: string; size: number; builtin: boolean }[]>([])
const previews = ref<Record<string, string>>({})
const msg = ref('')

const fitOptions = [
  { value: 'cover', label: '铺满（裁切）' },
  { value: 'contain', label: '完整显示' },
  { value: 'repeat', label: '平铺' }
]

async function loadFiles() {
  const r = await listBackgrounds()
  if (!r.ok) return
  files.value = r.data.files
  for (const f of files.value.slice(0, 12)) {
    if (previews.value[f.name]) continue
    const d = await backgroundData(f.name)
    if (d.ok && d.data.dataUrl) previews.value[f.name] = d.data.dataUrl
  }
}
onMounted(loadFiles)

function flash(t: string) {
  msg.value = t
  setTimeout(() => { if (msg.value === t) msg.value = '' }, 3000)
}

/** 一键恢复默认外观（看不清文字时的逃生通道） */
function resetAppearance() {
  emit('save', {
    theme: 'dark',
    bg_enabled: false,
    glass_enabled: false,
    card_translucent: true,
    glass_alpha: 0.72,
    glass_blur: 16,
    bg_dim: 35
  })
  flash('已重置为默认外观（深色主题 / 关闭背景与玻璃）')
}

function pickTheme(slug: string) {
  emit('save', { theme: slug })
}

async function onImport() {
  const r = await importBackground()
  if (r.ok && r.data.ok && r.data.name) {
    flash('已导入：' + r.data.name)
    await loadFiles()
    emit('save', { bg_enabled: true, bg_file: r.data.name })
  } else if (r.data && !r.data.ok && r.data.error !== '已取消') {
    flash('导入失败：' + (r.data.error ?? r.error ?? ''))
  }
}

async function onRemove(name: string) {
  if (!window.confirm('删除背景图「' + name + '」？')) return
  const r = await removeBackground(name)
  if (r.ok) {
    if (props.settings?.bg_file === name) emit('save', { bg_file: '', bg_enabled: false })
    await loadFiles()
    flash('已删除')
  }
}

function sizeText(n: number): string {
  return n > 1024 * 1024 ? (n / 1024 / 1024).toFixed(1) + ' MB' : Math.round(n / 1024) + ' KB'
}
</script>
<template>
  <section class="theme-pane">
    <div class="head">
      <h2>
        主题外观
        <InfoTip text="主题直接切换界面配色（12 套设计师方案，每套都有浅色与深色）。背景图会透过半透明的顶栏、侧边栏与卡片显示；建议图片不小于 1920×1080，重点内容放在左上角（其他区域常被卡片遮住）。" />
      </h2>
      <span class="cur">当前：<b>{{ THEMES.find((t) => t.slug === settings?.theme)?.name ?? settings?.theme }}</b></span>
      <button class="btn ghost" type="button" @click="resetAppearance">重置外观</button>
    </div>

    <div class="scroll">
      <div v-if="msg" class="msg">{{ msg }}</div>

      <div class="sec-title">主题</div>
      <div class="theme-grid">
        <button
          v-for="t in THEMES"
          :key="t.slug"
          class="theme-card"
          :class="{ on: settings?.theme === t.slug }"
          :data-theme="t.slug === 'system' ? undefined : t.slug"
          type="button"
          @click="pickTheme(t.slug)"
        >
          <div class="tc-swatches">
            <span class="sw bg"></span>
            <span class="sw card"></span>
            <span class="sw acc"></span>
            <span class="sw tx"></span>
          </div>
          <div class="tc-name">{{ t.name }}</div>
          <div class="tc-desc">{{ t.desc }}</div>
          <span v-if="settings?.theme === t.slug" class="tc-on">使用中</span>
        </button>
      </div>

      <div class="sec-title">背景图</div>
      <div class="field-inline">
        <span class="f-label">启用背景图</span>
        <label class="switch">
          <input type="checkbox" :checked="settings?.bg_enabled === true" @change="emit('save', { bg_enabled: ($event.target as HTMLInputElement).checked })" />
          <span class="sw-track"><span class="sw-thumb"></span></span>
        </label>
        <button class="btn primary" type="button" @click="onImport">导入本地图片</button>
        <span class="hint-inline">PNG / JPG / WebP，单张 ≤ 8MB，建议 2560×1440</span>
      </div>

      <div v-if="files.length === 0" class="empty-box">
        没有可用的背景图。点「导入本地图片」添加你自己的图（尺寸见上方提示）。
      </div>
      <div v-else class="bg-grid">
        <div
          v-for="f in files"
          :key="f.name"
          class="bg-card"
          :class="{ on: settings?.bg_file === f.name }"
        >
          <div class="bg-thumb" :style="previews[f.name] ? { backgroundImage: 'url(' + previews[f.name] + ')' } : {}"></div>
          <div class="bg-meta">
            <span class="bg-name" :title="f.name">{{ f.name }}</span>
            <span class="muted">{{ sizeText(f.size) }}</span>
          </div>
          <div class="bg-ops">
            <button class="btn ghost tiny" type="button" @click="emit('save', { bg_file: f.name, bg_enabled: true })">使用</button>
            <button v-if="!f.builtin" class="btn ghost tiny danger" type="button" @click="onRemove(f.name)">删除</button>
            <span v-else class="builtin-tag">内置</span>
          </div>
        </div>
      </div>

      <div class="sec-title">背景参数</div>
      <div class="field-inline">
        <span class="f-label">填充方式</span>
        <SelectMenu :model-value="settings?.bg_fit ?? 'cover'" :options="fitOptions" @update:model-value="(v) => emit('save', { bg_fit: v as Settings['bg_fit'] })" />
      </div>
      <div class="field-inline">
        <span class="f-label">蒙版强度</span>
        <input class="range" type="range" min="0" max="80" step="5" :value="settings?.bg_dim ?? 20" @input="emit('save', { bg_dim: Number(($event.target as HTMLInputElement).value) })" />
        <span class="num-val">{{ settings?.bg_dim ?? 20 }}%</span>
        <span class="hint-inline">越大文字越清晰（用底色压暗/提亮背景）</span>
      </div>
      <div class="field-inline">
        <span class="f-label">背景模糊</span>
        <input class="range" type="range" min="0" max="20" step="1" :value="settings?.bg_blur ?? 0" @input="emit('save', { bg_blur: Number(($event.target as HTMLInputElement).value) })" />
        <span class="num-val">{{ settings?.bg_blur ?? 0 }}px</span>
      </div>
      <div class="field-inline">
        <span class="f-label">液态玻璃</span>
        <label class="switch">
          <input type="checkbox" :checked="settings?.glass_enabled !== false" @change="emit('save', { glass_enabled: ($event.target as HTMLInputElement).checked })" />
          <span class="sw-track"><span class="sw-thumb"></span></span>
        </label>
        <span class="hint-inline">侧边栏 / 标题栏 / 卡片 / 弹窗都会变成毛玻璃，背景透过并高斯模糊</span>
      </div>
      <div class="field-inline">
        <span class="f-label">玻璃模糊</span>
        <input class="range" type="range" min="0" max="40" step="2" :value="settings?.glass_blur ?? 16" @input="emit('save', { glass_blur: Number(($event.target as HTMLInputElement).value) })" />
        <span class="num-val">{{ settings?.glass_blur ?? 16 }}px</span>
      </div>
      <div class="field-inline">
        <span class="f-label">玻璃通透度</span>
        <input class="range" type="range" min="45" max="95" step="5" :value="Math.round((settings?.glass_alpha ?? 0.72) * 100)" @input="emit('save', { glass_alpha: Number(($event.target as HTMLInputElement).value) / 100 })" />
        <span class="num-val">{{ Math.round((settings?.glass_alpha ?? 0.72) * 100) }}%</span>
        <span class="hint-inline">越小背景越明显；低于 55% 时文字可读性下降，建议 60%~75%</span>
      </div>
      <div class="field-inline">
        <span class="f-label">卡片半透明</span>
        <label class="switch">
          <input type="checkbox" :checked="settings?.card_translucent !== false" @change="emit('save', { card_translucent: ($event.target as HTMLInputElement).checked })" />
          <span class="sw-track"><span class="sw-thumb"></span></span>
        </label>
        <span class="hint-inline">开启后卡片 85% 不透明，背景会更明显地透出来</span>
      </div>
    </div>
  </section>
</template>

<style scoped>
.theme-pane { display: flex; flex-direction: column; height: 100%; }
.head { flex: none; display: flex; align-items: center; gap: 12px; padding: 20px var(--pad-lg) 8px; }
.head h2 { font-size: 19px; font-weight: 700; color: var(--tx-strong); margin: 0; display: flex; align-items: center; gap: 8px; }
.cur { margin-left: auto; font-size: 12.5px; color: var(--tx3); }
.cur b { color: var(--acc); }
.scroll { flex: 1; overflow-y: auto; padding: 8px var(--pad-lg) 40px; }
.msg { margin: 6px 0 10px; padding: 8px 12px; border-radius: 10px; background: var(--ok-soft); color: var(--tx); font-size: 12.5px; }
.sec-title { display: flex; align-items: center; gap: 8px; font-size: 13px; font-weight: 600; color: var(--tx); margin: 18px 0 10px; }
.sec-title::before { content: ''; width: 3px; height: 12px; border-radius: 2px; background: var(--acc-grad); }
.theme-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(158px, 1fr)); gap: 12px; }
.theme-card { position: relative; text-align: left; padding: 12px; border-radius: 14px; border: 1px solid var(--line); background: var(--card); color: var(--tx); cursor: pointer; transition: transform var(--dur) ease, border-color var(--dur) ease, box-shadow var(--dur) ease; }
.theme-card:hover { transform: translateY(-2px); border-color: var(--line-strong); box-shadow: var(--shadow-sm); }
.theme-card.on { border-color: var(--acc); box-shadow: 0 0 0 2px var(--acc-soft); }
.tc-swatches { display: flex; gap: 6px; margin-bottom: 10px; }
.sw { width: 22px; height: 22px; border-radius: 6px; border: 1px solid var(--line); }
.sw.bg { background: var(--bg-1); }
.sw.card { background: var(--card); }
.sw.acc { background: var(--acc); }
.sw.tx { background: var(--tx); }
.tc-name { font-size: 13px; font-weight: 700; color: var(--tx-strong); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.tc-desc { font-size: 11.5px; color: var(--tx3); margin-top: 2px; }
.tc-on { position: absolute; top: 10px; right: 10px; font-size: 10.5px; font-weight: 700; color: var(--on-acc); background: var(--acc); border-radius: 999px; padding: 1px 8px; }
.field-inline { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; margin-bottom: 12px; }
.f-label { font-size: var(--fs-sub); color: var(--tx2); font-weight: 500; min-width: 96px; }
.hint-inline { font-size: 11.5px; color: var(--tx3); }
.num-val { font-size: 12.5px; color: var(--acc); font-weight: 700; min-width: 44px; font-variant-numeric: tabular-nums; }
.range { width: 220px; accent-color: var(--acc); }
.empty-box { padding: 22px; border-radius: 14px; border: 1px dashed var(--line-strong); background: var(--card); color: var(--tx3); font-size: 13px; line-height: 1.8; text-align: center; }
.bg-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(190px, 1fr)); gap: 12px; }
.bg-card { border: 1px solid var(--line); border-radius: 12px; background: var(--card); overflow: hidden; display: flex; flex-direction: column; }
.bg-card.on { border-color: var(--acc); box-shadow: 0 0 0 2px var(--acc-soft); }
.bg-thumb { height: 96px; background: var(--panel2) center/cover no-repeat; }
.bg-meta { display: flex; align-items: center; gap: 8px; padding: 8px 10px 0; }
.bg-name { font-size: 12px; color: var(--tx); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; flex: 1; }
.bg-ops { display: flex; gap: 6px; padding: 8px 10px 10px; }
.btn.tiny { padding: 3px 10px; font-size: 11.5px; }
.btn.tiny.danger { color: var(--err); }
.muted { color: var(--tx3); font-size: 11.5px; }
.builtin-tag { font-size: 10.5px; font-weight: 700; color: var(--acc); background: var(--acc-soft); border-radius: 999px; padding: 1px 8px; }
</style>
