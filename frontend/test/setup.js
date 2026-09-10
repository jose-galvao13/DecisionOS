import "@testing-library/jest-dom/vitest";

// jsdom doesn't implement matchMedia or ResizeObserver, which some chart/
// UI code touches indirectly; stub them so component tests don't crash on
// environment gaps unrelated to what's being tested.
if (!window.matchMedia) {
  window.matchMedia = () => ({
    matches: false, addListener: () => {}, removeListener: () => {},
    addEventListener: () => {}, removeEventListener: () => {}, dispatchEvent: () => false,
  });
}
if (!window.ResizeObserver) {
  window.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
}
