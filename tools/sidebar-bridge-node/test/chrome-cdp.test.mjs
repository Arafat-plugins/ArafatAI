import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import { runChromeCdpCheck, selectChromeTarget } from '../src/chrome-cdp.mjs';

function makeFetch(targets) {
  return async (url) => {
    assert.match(String(url), /\/json\/list$/);
    return {
      ok: true,
      status: 200,
      async json() {
        return targets;
      },
    };
  };
}

function makeMockWebSocket(commands) {
  return class MockWebSocket {
    constructor(url) {
      this.url = url;
      this.readyState = 0;
      setTimeout(() => {
        this.readyState = 1;
        this.onopen?.();
      }, 0);
    }

    send(rawMessage) {
      const message = JSON.parse(rawMessage);
      commands.push(message);
      setTimeout(() => {
        this.onmessage?.({ data: JSON.stringify(responseFor(message)) });
        if (message.method === 'Runtime.enable') {
          this.onmessage?.({
            data: JSON.stringify({
              method: 'Runtime.consoleAPICalled',
              params: {
                type: 'log',
                args: [{ value: 'ready' }],
              },
            }),
          });
        }
        if (message.method === 'Network.enable') {
          this.onmessage?.({
            data: JSON.stringify({
              method: 'Network.responseReceived',
              params: {
                response: {
                  status: 200,
                  url: 'https://example.test/page',
                  mimeType: 'text/html',
                },
              },
            }),
          });
        }
        if (message.method === 'Page.navigate') {
          this.onmessage?.({ data: JSON.stringify({ method: 'Page.loadEventFired', params: {} }) });
        }
      }, 0);
    }

    close() {
      this.readyState = 3;
    }
  };
}

function responseFor(message) {
  if (message.method === 'Runtime.evaluate') {
    return {
      id: message.id,
      result: {
        result: {
          type: 'object',
          value: {
            exists: true,
            visible: true,
            text: 'Primary CTA',
            rect: { x: 10, y: 20, width: 120, height: 36 },
            layout: {
              viewport_width: 390,
              viewport_height: 844,
              document_width: 390,
              document_height: 1200,
              horizontal_overflow: false,
            },
            clickables: [{ text: 'Primary CTA' }],
            images: [{ alt: 'Hero', box: { x: 0, y: 0, width: 320, height: 180 } }],
          },
        },
      },
    };
  }
  if (message.method === 'Page.captureScreenshot') {
    return {
      id: message.id,
      result: {
        data: Buffer.from('fake png bytes').toString('base64'),
      },
    };
  }
  return { id: message.id, result: {} };
}

test('selects Chrome target by id, URL, title, or first page', () => {
  const targets = [
    { id: 'browser', type: 'browser' },
    { id: 'first', type: 'page', title: 'Home', url: 'https://example.test/', webSocketDebuggerUrl: 'ws://first' },
    { id: 'second', type: 'page', title: 'Directory', url: 'https://example.test/directory', webSocketDebuggerUrl: 'ws://second' },
  ];

  assert.equal(selectChromeTarget(targets, { target_id: 'second' }).id, 'second');
  assert.equal(selectChromeTarget(targets, { url_contains: '/directory' }).id, 'second');
  assert.equal(selectChromeTarget(targets, { title_contains: 'Home' }).id, 'first');
  assert.equal(selectChromeTarget(targets, {}).id, 'first');
});

test('runs Chrome CDP viewport, geolocation, selector assertion, network, and screenshot flow', async () => {
  const artifactRoot = await mkdtemp(path.join(os.tmpdir(), 'fluid-cdp-artifacts-'));
  const commands = [];
  const targets = [
    {
      id: 'page-1',
      type: 'page',
      title: 'Fixture',
      url: 'https://example.test/page',
      webSocketDebuggerUrl: 'ws://fixture/page-1',
    },
  ];

  try {
    const result = await runChromeCdpCheck({
      browser_url: 'http://127.0.0.1:9222',
      url_contains: 'example.test',
      navigate_url: 'https://example.test/page',
      viewport: { width: 390, height: 844, mobile: true, device_scale_factor: 2 },
      geolocation: { latitude: 52.7, longitude: -2.75, accuracy: 20 },
      selector: '.primary-cta',
      expect_visible: true,
      capture_network: true,
      screenshot: true,
      screenshot_label: 'primary cta',
    }, {
      fetchImpl: makeFetch(targets),
      WebSocketImpl: makeMockWebSocket(commands),
      artifactRoot,
    });

    assert.equal(result.ok, true);
    assert.equal(result.target.id, 'page-1');
    assert.equal(result.viewport.width, 390);
    assert.equal(result.geolocation.latitude, 52.7);
    assert.equal(result.assertion.selector, '.primary-cta');
    assert.equal(result.assertion.visible, true);
    assert.equal(result.assertion.layout.horizontal_overflow, false);
    assert.equal(result.assertion.clickables[0].text, 'Primary CTA');
    assert.equal(result.assertion.images[0].box.width, 320);
    assert.equal(result.console_events[0].text, 'ready');
    assert.equal(result.network_events[0].status, 200);
    assert.match(result.screenshot.path, /primary-cta-\d+\.png$/);
    assert.equal(await readFile(result.screenshot.path, 'utf8'), 'fake png bytes');

    const methods = commands.map((command) => command.method);
    assert.deepEqual(methods, [
      'Runtime.enable',
      'Page.enable',
      'Network.enable',
      'Emulation.setDeviceMetricsOverride',
      'Emulation.setGeolocationOverride',
      'Page.navigate',
      'Runtime.evaluate',
      'Page.captureScreenshot',
    ]);
  } finally {
    await rm(artifactRoot, { recursive: true, force: true });
  }
});
