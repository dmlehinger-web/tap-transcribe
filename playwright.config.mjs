import { defineConfig, devices } from '@playwright/test';

const fakeMedia = ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'];

export default defineConfig({
  testDir: 'tests',
  timeout: 90000,
  expect: { timeout: 30000 },
  workers: 1,
  fullyParallel: false,
  retries: 0,
  use: {
    baseURL: 'http://localhost:8765/tap-transcribe/',
    trace: 'off'
  },
  webServer: {
    command: 'mkdir -p /tmp/www && ln -sfn "$PWD" /tmp/www/tap-transcribe && python3 -m http.server 8765 --directory /tmp/www',
    url: 'http://localhost:8765/tap-transcribe/',
    reuseExistingServer: true,
    timeout: 20000
  },
  projects: [
    {
      name: 'iphone',
      use: {
        ...devices['iPhone 13'],
        browserName: 'chromium',
        launchOptions: { args: fakeMedia }
      }
    },
    {
      name: 'webkit-iphone',
      use: {
        ...devices['iPhone 13'],
        browserName: 'webkit'
      }
    }
  ]
});
