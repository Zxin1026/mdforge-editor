import { defineConfig } from 'electron-vite'

export default defineConfig({
  main: {
    build: {
      lib: { entry: 'src/main/index.ts' }
    }
  },
  preload: {
    build: {
      lib: { entry: 'src/preload/index.ts' }
    }
  },
  renderer: {}
})
