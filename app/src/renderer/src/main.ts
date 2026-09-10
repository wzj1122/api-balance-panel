import { createApp } from 'vue'
import App from './App.vue'
import './styles/variables.css'
import './styles/global.css'

// 主题防闪：mount 前按上次选择套用（没存过默认深色，和旧版一致）
try {
  const t = localStorage.getItem('panel-theme')
  document.documentElement.dataset.theme = t && t.length > 0 ? t : 'dark'
} catch {
  document.documentElement.dataset.theme = 'dark'
}

createApp(App).mount('#app')
