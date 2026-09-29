/**
 * The phone's Back.
 *
 * Nothing handled it, so on Android - the system back button, or the back swipe - with a chat
 * or any sheet open, Back left the site altogether: every connection dropped, any transfer
 * stopped, and the person was on whatever page they had come from. Every app on the phone
 * closes what is in front instead, and that is what people press it expecting.
 *
 * So each layer this app draws over itself - a sheet, a menu, the photo viewer - takes one
 * history entry while it is open. Back pops it and closes that layer. Closing a layer any other
 * way gives its entry back, so the history never fills up with stale ones. A layer that must be
 * answered, like the safety words, can refuse, and Back then does nothing.
 *
 * Driven here against a fake history that behaves like the real one: entries are counted, and
 * going back is asynchronous and fires `popstate`.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createBackStack } from '../web/ui/back.js';

/**
 * A history that behaves the way Chrome was measured to: `pushState` lands at once, and
 * `back()` lands later, on the entry before the one that was current *when it was called*.
 * So a push made while a back is still on its way ends up ahead of where the back lands.
 */
function fakeHistory() {
  const listeners = [];
  let index = 0;
  let length = 1;
  const h = {
    pushState() {
      index += 1;
      length = index + 1;
    },
    back() {
      if (index === 0) return;
      const target = index - 1;
      setTimeout(() => {
        index = target;
        listeners.forEach((fn) => fn({ type: 'popstate' }));
      }, 50);
    },
    get depth() {
      return index;
    },
    get length() {
      return length;
    },
  };
  // The user pressing Back is the same traversal, started by the browser.
  const press = async () => {
    h.back();
    await new Promise((r) => setTimeout(r, 90));
  };
  const on = (type, fn) => type === 'popstate' && listeners.push(fn);
  return { history: h, press, on };
}

// Long enough for a layer's entry to be given back, which waits a moment on purpose.
const settle = () => new Promise((r) => setTimeout(r, 500));

test('Back closes what is open instead of leaving the page', async () => {
  const { history, press, on } = fakeHistory();
  const back = createBackStack({ history, addEventListener: on });
  let closed = 0;
  back.open(() => {
    closed++;
  });
  assert.equal(history.depth, 1, 'opening a sheet did not take a history entry');
  await press();
  assert.equal(closed, 1, 'Back did not close the sheet');
  assert.equal(back.depth, 0);
  assert.equal(history.depth, 0, 'the page itself is still where it was');
});

test('the layer in front goes first', async () => {
  const { history, press, on } = fakeHistory();
  const back = createBackStack({ history, addEventListener: on });
  const order = [];
  back.open(() => order.push('chat'));
  back.open(() => order.push('menu'));
  await press();
  assert.deepEqual(order, ['menu']);
  await press();
  assert.deepEqual(order, ['menu', 'chat']);
});

test('closing a layer some other way gives its entry back, and is not closed twice', async () => {
  const { history, press, on } = fakeHistory();
  const back = createBackStack({ history, addEventListener: on });
  let closes = 0;
  const closedByButton = back.open(() => {
    closes++;
  });
  closedByButton();
  await settle();
  assert.equal(history.depth, 0, 'a sheet closed with its button left an entry behind');
  assert.equal(closes, 0, 'the traversal that removed the entry closed the sheet a second time');
  // And the next real Back is the page's again.
  closedByButton();
  assert.equal(history.depth, 0);
  await press();
  assert.equal(closes, 0);
});

test('a layer underneath closed by code does not steal the Back meant for the one in front', async () => {
  const { history, press, on } = fakeHistory();
  const back = createBackStack({ history, addEventListener: on });
  const order = [];
  const lower = back.open(() => order.push('lower'));
  back.open(() => order.push('upper'));
  lower(); // e.g. an offer withdrawn while a menu was open over it
  await settle();
  assert.equal(history.depth, 1);
  await press();
  assert.deepEqual(order, ['upper']);
  assert.equal(history.depth, 0);
});

test('a layer that must be answered can refuse, and Back then does nothing', async () => {
  const { history, press, on } = fakeHistory();
  const back = createBackStack({ history, addEventListener: on });
  let asked = 0;
  back.open(() => {
    asked++;
    return false;
  });
  await press();
  assert.equal(asked, 1);
  assert.equal(back.depth, 1, 'the refusing layer was forgotten');
  assert.equal(history.depth, 1, 'the next Back would leave the page with the question still up');
});

test('with nothing open, Back is the browser\'s', async () => {
  const { history, press, on } = fakeHistory();
  createBackStack({ history, addEventListener: on });
  await press(); // nothing to do, nothing thrown
  assert.equal(history.depth, 0);
});

test('a sheet that opens as a menu closes does not leave Back pointing out of the page', async () => {
  /*
   * Found in a real browser: choose Chat from a device menu, and the menu closing handed its
   * entry back at the same moment the chat took one. The back landed on the entry before the
   * menu's, behind the chat's, so the next Back left the site with the chat still open.
   */
  const { history, press, on } = fakeHistory();
  const back = createBackStack({ history, addEventListener: on });
  const order = [];
  const menuClosed = back.open(() => order.push('menu'));
  menuClosed();
  back.open(() => order.push('chat'));
  await settle();
  assert.equal(history.depth, 1, 'the chat is not one entry above the page');
  await press();
  assert.deepEqual(order, ['chat'], 'Back did not close the chat');
  assert.equal(history.depth, 0);
});

test('a sheet opening while an entry is still being handed back waits for it', async () => {
  const { history, press, on } = fakeHistory();
  const back = createBackStack({ history, addEventListener: on });
  const order = [];
  const first = back.open(() => order.push('first'));
  first();
  // Past the pause, and inside the fifty milliseconds the entry takes to come back.
  await new Promise((r) => setTimeout(r, 275));
  back.open(() => order.push('second'));
  await settle();
  assert.equal(history.depth, 1);
  await press();
  assert.deepEqual(order, ['second']);
  assert.equal(history.depth, 0);
});

test('Back just after a menu closed itself closes the sheet that is showing', async () => {
  // The menu's entry is spare for a moment. A press that used it and closed nothing would look
  // like Back not working.
  const { history, press, on } = fakeHistory();
  const back = createBackStack({ history, addEventListener: on });
  const order = [];
  back.open(() => order.push('chat'));
  const menuClosed = back.open(() => order.push('menu'));
  menuClosed();
  await press();
  assert.deepEqual(order, ['chat'], 'the press closed nothing');
  await settle();
  assert.equal(history.depth, 0, 'an entry was left behind');
});
