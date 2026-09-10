<script setup lang="ts">
const emit = defineEmits<{ (e: 'add'): void }>()
</script>

<template>
  <div class="empty">
    <div class="art" aria-hidden="true">
      <svg viewBox="0 0 220 150" width="220" height="150" fill="none">
        <defs>
          <linearGradient id="es-grad" x1="0" y1="0" x2="1" y2="1">
            <stop offset="0" stop-color="#4f8cff" />
            <stop offset="1" stop-color="#22d3ee" />
          </linearGradient>
          <linearGradient id="es-card" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" stop-color="#1a2231" />
            <stop offset="1" stop-color="#12161f" />
          </linearGradient>
        </defs>

        <!-- 背景光晕 -->
        <ellipse cx="110" cy="86" rx="86" ry="52" fill="url(#es-grad)" opacity="0.10" />

        <!-- 左侧卡片 -->
        <rect x="26" y="52" width="78" height="74" rx="12" fill="url(#es-card)" stroke="rgba(255,255,255,0.08)" />
        <rect x="38" y="68" width="40" height="6" rx="3" fill="rgba(255,255,255,0.22)" />
        <rect x="38" y="82" width="54" height="4" rx="2" fill="rgba(255,255,255,0.10)" />
        <rect x="38" y="92" width="34" height="4" rx="2" fill="rgba(255,255,255,0.10)" />
        <path d="M40 108h36" stroke="rgba(79,140,255,0.5)" stroke-width="2" stroke-linecap="round" />

        <!-- 右侧卡片 -->
        <rect x="116" y="38" width="78" height="74" rx="12" fill="url(#es-card)" stroke="rgba(255,255,255,0.08)" />
        <rect x="128" y="54" width="40" height="6" rx="3" fill="rgba(255,255,255,0.22)" />
        <rect x="128" y="68" width="54" height="4" rx="2" fill="rgba(255,255,255,0.10)" />

        <!-- 右侧卡片里的折线 -->
        <polyline
          points="134,92 146,84 156,89 168,74 180,80 186,70"
          stroke="url(#es-grad)"
          stroke-width="2.5"
          stroke-linecap="round"
          stroke-linejoin="round"
        />
        <circle cx="186" cy="70" r="3.5" fill="#22d3ee" />

        <!-- 中间 + 徽标 -->
        <circle cx="155" cy="120" r="15" fill="url(#es-grad)" />
        <path d="M155 115v10M150 120h10" stroke="#fff" stroke-width="2.2" stroke-linecap="round" />

        <!-- 连接线 -->
        <path d="M102 90c8 6 6 14 14 16" stroke="rgba(255,255,255,0.14)" stroke-width="1.6" stroke-dasharray="3 4" stroke-linecap="round" />
      </svg>
    </div>

    <h2 class="title">还没有配置任何账号</h2>
    <p class="desc">把 DeepSeek、硅基流动、中转站、MiMo 的余额集中到一个窗口，<br />自动定时刷新，低余额第一时间提醒</p>

    <button class="btn primary lg" type="button" @click="emit('add')">
      <svg class="ico" viewBox="0 0 16 16" width="15" height="15">
        <path fill="currentColor" d="M7.2 7.2V3h1.6v4.2H13v1.6H8.8V13H7.2V8.8H3V7.2h4.2Z" />
      </svg>
      添加第一个账号
    </button>

    <p class="tip">🔒 密钥只存在你自己的电脑上，程序不联网上报，也不经过任何中间服务器。</p>
  </div>
</template>

<style scoped>
.empty {
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  text-align: center;
  padding: 40px;
  gap: 8px;
}

.art {
  margin-bottom: 14px;
  filter: drop-shadow(0 14px 30px rgba(0, 0, 0, 0.35));
}

.title {
  font-size: 21px;
  font-weight: 700;
  color: var(--tx-strong);
  margin: 6px 0 4px;
  letter-spacing: 0.2px;
}

.desc {
  color: var(--tx2);
  font-size: 14px;
  margin: 0 0 20px;
  line-height: 1.75;
}

.ico {
  flex: none;
}

.tip {
  margin-top: 26px;
  color: var(--tx3);
  font-size: var(--fs-foot);
  background: rgba(255, 255, 255, 0.035);
  border: 1px solid var(--line);
  border-radius: 999px;
  padding: 7px 16px;
}
</style>
