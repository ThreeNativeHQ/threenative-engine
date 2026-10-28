import {
  playtestDiagnostic,
  type IPlaytestPathAssertion,
  type IPlaytestVisualRegionBounds,
  type IPlaytestVisualRegionTarget,
} from "../index.js";
import type { IPlaytestHudAuditItem } from "../assertion-report.js";
import { PlaytestBridgeError } from "./bridgeClient.js";
import type { Page } from "playwright";
import { PNG } from "pngjs";

interface IElementVisibilitySample {
  bounds?: IPlaytestVisualRegionBounds;
  rendered: boolean;
}

interface IDomElementVisibilitySample extends IElementVisibilitySample {
  clip?: { height: number; width: number; x: number; y: number };
  isolationKey?: string;
  isolationFailure?: string;
}

interface IVisibilityIsolationPropertyState {
  name: string;
  pageOwned: boolean;
  originalPriority: string;
  originalValue: string;
  temporaryPriority: string;
  temporaryValue: string;
}

interface IVisibilityIsolationElementState {
  element: Element;
  properties: IVisibilityIsolationPropertyState[];
}

interface IVisibilityIsolationDomElementState {
  element: Element;
  nextSibling: Node | null;
  parent: Element | null;
  previousSibling: Node | null;
}

interface IVisibilityIsolationState {
  domSnapshot: IVisibilityIsolationDomElementState[];
  elements: Element[];
  hiddenElements: IVisibilityIsolationElementState[];
  markerAttribute: string;
  mutationTracker: IVisibilityIsolationMutationTracker;
  probe: Element;
  probeAttribute: string;
  style: HTMLStyleElement;
}

interface IVisibilityIsolationMutationTracker {
  changed: boolean;
  domChanged: boolean;
  stop: () => void;
}

interface IVisibilityIsolationCleanupResult {
  cleaned: boolean;
  isolationIntact: boolean;
}

let visibilityIsolationSequence = 0;

/** Proves a DOM target contributes visible pixels and is not hidden by another painted node. */
export async function sampleElementVisibility(
  page: Page,
  target: IPlaytestVisualRegionTarget,
): Promise<IElementVisibilitySample> {
  const isolationKey = `__threenativePlaytestVisibilityIsolation${visibilityIsolationSequence++}`;
  const domSample = await page.evaluate(({ requestedTarget, isolationKey }): IDomElementVisibilitySample => {
    const node = requestedTarget.id === undefined
      ? (() => {
          try {
            return requestedTarget.selector === undefined ? null : document.querySelector(requestedTarget.selector);
          } catch {
            return null;
          }
        })()
      : document.getElementById(requestedTarget.id);
    if (node === null) return { rendered: false };

    const rect = node.getBoundingClientRect();
    const bounds: IPlaytestVisualRegionBounds | undefined = [rect.height, rect.width, rect.left, rect.top].every(Number.isFinite) && rect.width > 0 && rect.height > 0
      ? { height: rect.height, width: rect.width, x: rect.left, y: rect.top }
      : undefined;
    if (bounds === undefined) return { rendered: false };

    let rendered = true;
    for (let current: Element | null = node; rendered && current !== null; current = current.parentElement) {
      const style = window.getComputedStyle(current);
      const opacity = Number.parseFloat(style.opacity);
      const contentVisibility = style.getPropertyValue?.("content-visibility") || style.contentVisibility;
      rendered = style.display !== "none"
        && style.visibility !== "hidden"
        && style.visibility !== "collapse"
        && contentVisibility !== "hidden"
        && (!Number.isFinite(opacity) || opacity > 0);
    }
    if (!rendered) return { bounds, rendered: false };

    const left = Math.max(0, bounds.x);
    const top = Math.max(0, bounds.y);
    const right = Math.min(window.innerWidth, bounds.x + bounds.width);
    const bottom = Math.min(window.innerHeight, bounds.y + bounds.height);
    if (right <= left || bottom <= top) return { bounds, rendered: false };

    const centerX = Math.min(Math.max(bounds.x + bounds.width / 2, 0), Math.max(0, window.innerWidth - 1));
    const centerY = Math.min(Math.max(bounds.y + bounds.height / 2, 0), Math.max(0, window.innerHeight - 1));
    const pointerEventsStyle = document.createElement("style");
    pointerEventsStyle.textContent = "* { pointer-events: auto !important; }";
    if (document.head === null) return { bounds, rendered: false };
    document.head.appendChild(pointerEventsStyle);
    try {
      const topmost = document.elementFromPoint(centerX, centerY);
      rendered = topmost === node || (topmost !== null && node.contains(topmost));
    } catch {
      rendered = false;
    } finally {
      try {
        pointerEventsStyle.remove();
      } catch {
        rendered = false;
      }
    }

    if (!rendered) return { bounds, rendered: false };

    const markerAttribute = `data-threenative-visibility-${isolationKey}`;
    const probeAttribute = `data-threenative-visibility-probe-${isolationKey}`;
    const markedElements = [node];
    const hiddenElements: IVisibilityIsolationElementState[] = [];
    let isolationStyle: HTMLStyleElement | undefined;
    let isolationProbe: Element | undefined;
    let stopMutationTracking: (() => void) | undefined;
    const restoreHiddenElements = (): boolean => {
      let cleaned = true;
      for (const { element, properties } of hiddenElements) {
        try {
          const inlineStyle = (element as HTMLElement).style;
          for (const property of properties) {
            if (property.pageOwned) continue;
            if (inlineStyle.getPropertyValue(property.name) !== property.temporaryValue
              || inlineStyle.getPropertyPriority(property.name) !== property.temporaryPriority) continue;
            if (property.originalValue === "") inlineStyle.removeProperty(property.name);
            else inlineStyle.setProperty(property.name, property.originalValue, property.originalPriority);
          }
        } catch {
          cleaned = false;
        }
      }
      return cleaned;
    };
    const cleanupIsolation = (): boolean => {
      let cleaned = true;
      try {
        stopMutationTracking?.();
      } catch {
        cleaned = false;
      }
      try {
        isolationStyle?.remove();
      } catch {
        cleaned = false;
      }
      if (!restoreHiddenElements()) cleaned = false;
      for (const element of markedElements) {
        try {
          element.removeAttribute(markerAttribute);
        } catch {
          cleaned = false;
        }
      }
      try {
        isolationProbe?.removeAttribute(probeAttribute);
      } catch {
        cleaned = false;
      }
      try {
        isolationProbe?.removeAttribute("style");
      } catch {
        cleaned = false;
      }
      try {
        isolationProbe?.remove();
      } catch {
        cleaned = false;
      }
      return cleaned;
    };
    try {
      node.setAttribute(markerAttribute, "");

      const documentElement = document.documentElement ?? null;
      const body = document.body ?? null;
      const targetContainsDocumentElement = documentElement !== null
        && (node === documentElement || node.contains(documentElement));
      const targetContainsBody = body !== null
        && (node === body || node.contains(body));
      if (document.head === null) throw new Error("Cannot isolate a visibility target without document.head");
      isolationProbe = document.createElement("span");
      isolationProbe.setAttribute(probeAttribute, "");
      isolationProbe.setAttribute("style", [
        "position: fixed !important",
        "top: 0 !important",
        "left: 0 !important",
        "width: 0 !important",
        "height: 0 !important",
        "margin: 0 !important",
        "padding: 0 !important",
        "border: 0 !important",
        "display: block !important",
        "flex: none !important",
      ].join("; "));
      const probeParent = targetContainsDocumentElement || targetContainsBody || body === null ? document.head : body;
      if (probeParent === null) throw new Error("Cannot isolate a visibility target without a probe parent");
      probeParent.appendChild(isolationProbe);
      if (window.getComputedStyle(isolationProbe).visibility !== "visible") {
        throw new Error("Cannot verify a visible visibility isolation probe");
      }
      const documentElements = documentElement === null
        ? []
        : [documentElement, ...documentElement.querySelectorAll("*")];
      for (const element of documentElements) {
        if (element === isolationProbe || element === node || node.contains(element)) continue;
        const inlineStyle = (element as HTMLElement).style;
        const properties = [
          { name: "visibility", temporaryValue: "hidden" },
          ...(element === documentElement || element === body
            ? [
                { name: "background-color", temporaryValue: "transparent" },
                { name: "background-image", temporaryValue: "none" },
              ]
            : []),
        ].map(({ name, temporaryValue }) => ({
          name,
          pageOwned: false,
          originalPriority: inlineStyle.getPropertyPriority(name),
          originalValue: inlineStyle.getPropertyValue(name),
          temporaryPriority: "important",
          temporaryValue,
        }));
        hiddenElements.push({ element, properties });
        for (const property of properties) {
          inlineStyle.setProperty(property.name, property.temporaryValue, property.temporaryPriority);
          property.temporaryValue = inlineStyle.getPropertyValue(property.name);
          property.temporaryPriority = inlineStyle.getPropertyPriority(property.name);
        }
      }
      isolationStyle = document.createElement("style");
      isolationStyle.textContent = [
        targetContainsDocumentElement ? "" : "html { background: transparent !important; visibility: hidden !important; }",
        targetContainsBody ? "" : "body { background: transparent !important; visibility: hidden !important; }",
        `body *:not([${markerAttribute}]):not([${markerAttribute}] *) { visibility: hidden !important; }`,
        `[${markerAttribute}] { visibility: visible !important; }`,
        targetContainsDocumentElement || targetContainsBody || body === null
          ? `[${probeAttribute}] { visibility: hidden !important; }`
          : "",
      ].filter(Boolean).join("\n");
      document.head.appendChild(isolationStyle);
      const targetVisibility = window.getComputedStyle(node).visibility;
      const probeVisibility = window.getComputedStyle(isolationProbe).visibility;
      const transparentBackground = (element: Element | null): boolean => {
        if (element === null) return true;
        const style = window.getComputedStyle(element);
        return (style.backgroundColor === "transparent" || style.backgroundColor === "rgba(0, 0, 0, 0)")
          && style.backgroundImage === "none";
      };
      const rootsAreTransparent = (targetContainsDocumentElement || transparentBackground(documentElement))
        && (targetContainsBody || transparentBackground(body));
      const nonTargetElementsAreHidden = hiddenElements.every(({ element }) => window.getComputedStyle(element).visibility === "hidden");
      if (targetVisibility !== "visible" || probeVisibility !== "hidden" || !rootsAreTransparent || !nonTargetElementsAreHidden) {
        throw new Error("Cannot verify active visibility isolation rules");
      }
      const mutationTracker: IVisibilityIsolationMutationTracker = {
        changed: false,
        domChanged: false,
        stop: () => undefined,
      };
      const restorations: Array<() => void> = [];
      let tracking = true;
      const stop = (): void => {
        if (!tracking) return;
        tracking = false;
        let restorationFailed = false;
        for (let index = restorations.length - 1; index >= 0; index -= 1) {
          try {
            restorations[index]?.();
          } catch {
            restorationFailed = true;
          }
        }
        if (restorationFailed) throw new Error("temporary visibility mutation instrumentation could not be removed");
      };
      stopMutationTracking = stop;

      const liveDomSnapshot = (): IVisibilityIsolationDomElementState[] => {
        const liveDocumentElement = document.documentElement ?? null;
        const liveElements = liveDocumentElement === null
          ? []
          : [liveDocumentElement, ...liveDocumentElement.querySelectorAll("*")];
        return liveElements.map((element) => ({
          element,
          nextSibling: element.nextSibling,
          parent: element.parentElement,
          previousSibling: element.previousSibling,
        }));
      };
      const domSnapshot = liveDomSnapshot();
      const markDomChanged = (): void => {
        if (!tracking) return;
        mutationTracker.changed = true;
        mutationTracker.domChanged = true;
      };
      const styleOwners = new Map<CSSStyleDeclaration, Element>();
      const propertyOwnership = new Map<Element, Map<string, IVisibilityIsolationPropertyState>>();
      for (const { element, properties } of hiddenElements) {
        styleOwners.set((element as HTMLElement).style, element);
        propertyOwnership.set(element, new Map(properties.map((property) => [property.name, property])));
      }
      const markPageOwned = (element: Element, names: Iterable<string>): void => {
        const properties = propertyOwnership.get(element);
        if (properties === undefined) return;
        for (const name of names) {
          const property = properties.get(name);
          if (property !== undefined) property.pageOwned = true;
        }
        mutationTracker.changed = true;
      };
      const markStylePropertiesOwned = (style: CSSStyleDeclaration, names: Iterable<string>): void => {
        const element = styleOwners.get(style);
        if (element !== undefined) markPageOwned(element, names);
      };
      const trackStyleAttributeMutation = (element: Element, names: Set<string>): void => {
        markPageOwned(element, names);
      };

      const descriptorInPrototypeChain = (object: object, name: string): PropertyDescriptor | undefined => {
        let current: object | null = object;
        while (current !== null) {
          const descriptor = Object.getOwnPropertyDescriptor(current, name);
          if (descriptor !== undefined) return descriptor;
          current = Object.getPrototypeOf(current);
        }
        return undefined;
      };
      const restoreProperty = (object: object, name: string, originalDescriptor: PropertyDescriptor | undefined, replacement: unknown): void => {
        const currentDescriptor = Object.getOwnPropertyDescriptor(object, name);
        if (currentDescriptor?.value !== replacement && currentDescriptor?.get !== replacement) {
          mutationTracker.changed = true;
          return;
        }
        if (originalDescriptor === undefined) {
          if (!Reflect.deleteProperty(object, name)) throw new Error(`Cannot remove temporary ${name} instrumentation`);
        } else Object.defineProperty(object, name, originalDescriptor);
      };
      const instrumentStyleMethod = (
        style: CSSStyleDeclaration,
        names: Set<string>,
        methodName: "removeProperty" | "setProperty",
      ): void => {
        // quality-allow: CSSStyleDeclaration is indexed by name here to patch it in the page.
        const styleRecord = style as unknown as Record<string, unknown>;
        const originalDescriptor = Object.getOwnPropertyDescriptor(style, methodName);
        const originalMethod = styleRecord[methodName];
        if (typeof originalMethod !== "function") throw new Error(`Cannot instrument CSSStyleDeclaration.${methodName}`);
        const callOriginal = originalMethod as (...args: unknown[]) => unknown;
        const temporaryMethod = function(this: CSSStyleDeclaration, ...args: unknown[]): unknown {
          const result = callOriginal.apply(this, args);
          if (tracking && this === style && typeof args[0] === "string" && names.has(args[0].trim().toLowerCase())) {
            markStylePropertiesOwned(style, [args[0].trim().toLowerCase()]);
          }
          return result;
        };
        Object.defineProperty(style, methodName, {
          configurable: true,
          enumerable: originalDescriptor?.enumerable ?? true,
          value: temporaryMethod,
          writable: true,
        });
        restorations.push(() => restoreProperty(style, methodName, originalDescriptor, temporaryMethod));
      };
      const instrumentStyleProperty = (
        style: CSSStyleDeclaration,
        name: string,
        originalSetProperty: (...args: unknown[]) => unknown,
        originalGetPropertyValue: (...args: unknown[]) => unknown,
      ): void => {
        const propertyName = name.replace(/-([a-z])/g, (_, letter: string) => letter.toUpperCase());
        const originalOwnDescriptor = Object.getOwnPropertyDescriptor(style, propertyName);
        if (descriptorInPrototypeChain(style, propertyName) === undefined) {
          throw new Error(`Cannot instrument CSSStyleDeclaration.${propertyName}`);
        }
        const temporaryGetter = function(this: CSSStyleDeclaration): unknown {
          return originalGetPropertyValue.call(this, name);
        };
        const temporarySetter = function(this: CSSStyleDeclaration, value: unknown): void {
          originalSetProperty.call(this, name, String(value));
          if (tracking && this === style) markStylePropertiesOwned(style, [name]);
        };
        Object.defineProperty(style, propertyName, {
          configurable: true,
          enumerable: originalOwnDescriptor?.enumerable ?? true,
          get: temporaryGetter,
          set: temporarySetter,
        });
        restorations.push(() => {
          const currentDescriptor = Object.getOwnPropertyDescriptor(style, propertyName);
          if (currentDescriptor?.get !== temporaryGetter) {
            mutationTracker.changed = true;
            return;
          }
          if (originalOwnDescriptor === undefined) {
            if (!Reflect.deleteProperty(style, propertyName)) throw new Error(`Cannot remove temporary ${propertyName} instrumentation`);
            return;
          }
          if (Object.hasOwn(originalOwnDescriptor, "value")) {
            const currentValue = originalGetPropertyValue.call(style, name);
            if (!Reflect.deleteProperty(style, propertyName)) throw new Error(`Cannot remove temporary ${propertyName} instrumentation`);
            if (Object.getOwnPropertyDescriptor(style, propertyName) === undefined) {
              Object.defineProperty(style, propertyName, { ...originalOwnDescriptor, value: currentValue });
            }
            return;
          }
          Object.defineProperty(style, propertyName, originalOwnDescriptor);
        });
      };
      const instrumentStyleCssText = (style: CSSStyleDeclaration, names: Set<string>): void => {
        const originalOwnDescriptor = Object.getOwnPropertyDescriptor(style, "cssText");
        const originalDescriptor = descriptorInPrototypeChain(style, "cssText");
        if (originalDescriptor?.get === undefined || originalDescriptor.set === undefined) {
          throw new Error("Cannot instrument CSSStyleDeclaration.cssText");
        }
        const temporaryGetter = function(this: CSSStyleDeclaration): unknown {
          return originalDescriptor.get?.call(this);
        };
        const temporarySetter = function(this: CSSStyleDeclaration, value: unknown): void {
          originalDescriptor.set?.call(this, String(value));
          if (tracking && this === style) markStylePropertiesOwned(style, names);
        };
        Object.defineProperty(style, "cssText", {
          configurable: true,
          enumerable: originalOwnDescriptor?.enumerable ?? originalDescriptor.enumerable ?? true,
          get: temporaryGetter,
          set: temporarySetter,
        });
        restorations.push(() => restoreProperty(style, "cssText", originalOwnDescriptor, temporaryGetter));
      };
      const isStyleAttribute = (value: unknown): boolean => typeof value === "string" && value.trim().toLowerCase() === "style";
      const instrumentElementMethod = (
        element: Element,
        names: Set<string>,
        methodName: string,
        shouldTrack: (args: unknown[]) => boolean,
      ): void => {
        // quality-allow: the element is indexed by method name to wrap it inside the page.
        const elementRecord = element as unknown as Record<string, unknown>;
        const originalDescriptor = Object.getOwnPropertyDescriptor(element, methodName);
        const originalMethod = elementRecord[methodName];
        if (typeof originalMethod !== "function") return;
        const callOriginal = originalMethod as (...args: unknown[]) => unknown;
        const temporaryMethod = function(this: Element, ...args: unknown[]): unknown {
          const shouldCheck = this === element && shouldTrack(args);
          const result = callOriginal.apply(this, args);
          if (shouldCheck && tracking) trackStyleAttributeMutation(element, names);
          return result;
        };
        Object.defineProperty(element, methodName, {
          configurable: true,
          enumerable: originalDescriptor?.enumerable ?? false,
          value: temporaryMethod,
          writable: true,
        });
        restorations.push(() => restoreProperty(element, methodName, originalDescriptor, temporaryMethod));
      };
      const instrumentNodeMethod = (node: object, methodName: string): void => {
        const nodeRecord = node as Record<string, unknown>;
        const originalDescriptor = Object.getOwnPropertyDescriptor(node, methodName);
        const originalMethod = nodeRecord[methodName];
        if (typeof originalMethod !== "function") return;
        const callOriginal = originalMethod as (...args: unknown[]) => unknown;
        const temporaryMethod = function(this: object, ...args: unknown[]): unknown {
          const result = callOriginal.apply(this, args);
          if (tracking && this === node) markDomChanged();
          return result;
        };
        Object.defineProperty(node, methodName, {
          configurable: true,
          enumerable: originalDescriptor?.enumerable ?? false,
          value: temporaryMethod,
          writable: true,
        });
        restorations.push(() => restoreProperty(node, methodName, originalDescriptor, temporaryMethod));
      };
      const instrumentNodeProperty = (node: object, propertyName: string): void => {
        const originalOwnDescriptor = Object.getOwnPropertyDescriptor(node, propertyName);
        const originalDescriptor = descriptorInPrototypeChain(node, propertyName);
        if (originalDescriptor?.set === undefined) return;
        const temporaryGetter = originalDescriptor.get === undefined
          ? undefined
          : function(this: object): unknown {
              return originalDescriptor.get?.call(this);
            };
        const temporarySetter = function(this: object, value: unknown): void {
          originalDescriptor.set?.call(this, value);
          if (tracking && this === node) markDomChanged();
        };
        Object.defineProperty(node, propertyName, {
          configurable: true,
          enumerable: originalOwnDescriptor?.enumerable ?? originalDescriptor.enumerable ?? true,
          get: temporaryGetter,
          set: temporarySetter,
        });
        restorations.push(() => {
          const currentDescriptor = Object.getOwnPropertyDescriptor(node, propertyName);
          if (currentDescriptor?.get !== temporaryGetter || currentDescriptor?.set !== temporarySetter) {
            mutationTracker.changed = true;
            return;
          }
          if (originalOwnDescriptor === undefined) {
            if (!Reflect.deleteProperty(node, propertyName)) throw new Error(`Cannot remove temporary ${propertyName} instrumentation`);
            return;
          }
          Object.defineProperty(node, propertyName, originalOwnDescriptor);
        });
      };
      for (const { element, properties } of hiddenElements) {
        const names = new Set(properties.map(({ name }) => name));
        const style = (element as HTMLElement).style;
        // quality-allow: the original is stored and re-invoked positionally, not re-typed.
        const originalSetProperty = style.setProperty as unknown as (...args: unknown[]) => unknown;
        // quality-allow: the original is stored and re-invoked positionally, not re-typed.
        const originalGetPropertyValue = style.getPropertyValue as unknown as (...args: unknown[]) => unknown;
        instrumentStyleMethod(style, names, "setProperty");
        instrumentStyleMethod(style, names, "removeProperty");
        instrumentStyleCssText(style, names);
        for (const name of names) instrumentStyleProperty(style, name, originalSetProperty, originalGetPropertyValue);
        instrumentElementMethod(element, names, "setAttribute", (args) => isStyleAttribute(args[0]));
        instrumentElementMethod(element, names, "setAttributeNS", (args) => (args[0] === null || args[0] === "") && isStyleAttribute(args[1]));
        instrumentElementMethod(element, names, "removeAttribute", (args) => isStyleAttribute(args[0]));
        instrumentElementMethod(element, names, "toggleAttribute", (args) => isStyleAttribute(args[0]));
        instrumentElementMethod(element, names, "setAttributeNode", (args) => {
          const attribute = args[0] as { name?: unknown; namespaceURI?: unknown } | null | undefined;
          return attribute !== null && attribute !== undefined
            && (attribute.namespaceURI === null || attribute.namespaceURI === undefined || attribute.namespaceURI === "")
            && isStyleAttribute(attribute.name);
        });
        instrumentElementMethod(element, names, "removeAttributeNode", (args) => {
          const attribute = args[0] as { name?: unknown; namespaceURI?: unknown } | null | undefined;
          return attribute !== null && attribute !== undefined
            && (attribute.namespaceURI === null || attribute.namespaceURI === undefined || attribute.namespaceURI === "")
            && isStyleAttribute(attribute.name);
        });
      }
      const domNodes: object[] = [document, ...domSnapshot.map(({ element }) => element)];
      const domMethods = [
        "after",
        "append",
        "appendChild",
        "before",
        "close",
        "insertAdjacentElement",
        "insertAdjacentHTML",
        "insertAdjacentText",
        "insertBefore",
        "moveBefore",
        "open",
        "prepend",
        "remove",
        "removeChild",
        "replaceChild",
        "replaceChildren",
        "replaceWith",
        "setHTML",
        "setHTMLUnsafe",
        "write",
        "writeln",
      ];
      const domProperties = ["innerHTML", "innerText", "outerHTML", "textContent"];
      for (const domNode of domNodes) {
        for (const methodName of domMethods) instrumentNodeMethod(domNode, methodName);
        for (const propertyName of domProperties) instrumentNodeProperty(domNode, propertyName);
      }
      mutationTracker.stop = stop;
      // quality-allow: the isolation state is parked on the page's window under a private key.
      (window as unknown as Record<string, IVisibilityIsolationState>)[isolationKey] = {
        domSnapshot,
        elements: markedElements,
        hiddenElements,
        markerAttribute,
        mutationTracker,
        probe: isolationProbe,
        probeAttribute,
        style: isolationStyle,
      };
      return {
        bounds,
        clip: { height: bottom - top, width: right - left, x: left, y: top },
        isolationKey,
        rendered: true,
      };
    } catch (error) {
      const cleaned = cleanupIsolation();
      const reason = error instanceof Error ? error.message : "temporary visibility isolation could not be verified";
      return {
        bounds,
        isolationFailure: cleaned ? reason : `${reason}; temporary isolation cleanup was incomplete`,
        rendered: false,
      };
    }
  }, { isolationKey, requestedTarget: target }).catch(() => undefined);

  if (domSample?.isolationFailure !== undefined) {
    const targetDescription = target.id === undefined ? `selector '${target.selector ?? ""}'` : `id '${target.id}'`;
    throw new PlaytestBridgeError(playtestDiagnostic(
      "TN_PLAYTEST_OBSERVATION_UNAVAILABLE",
      `Could not verify DOM visibility isolation for ${targetDescription}: ${domSample.isolationFailure}.`,
      "Allow the playtest's temporary visibility styles, or remove the page policy that blocks them, then rerun the playtest.",
    ));
  }
  if (domSample === undefined || !domSample.rendered || domSample.clip === undefined) {
    return { ...(domSample?.bounds === undefined ? {} : { bounds: domSample.bounds }), rendered: false };
  }
  if (domSample.isolationKey === undefined) return { bounds: domSample.bounds, rendered: false };
  let screenshot: Buffer | undefined;
  let screenshotFailure: string | undefined;
  let cleanupResult: IVisibilityIsolationCleanupResult | undefined;
  try {
    screenshot = await page.screenshot({ clip: domSample.clip, omitBackground: true });
  } catch (error) {
    screenshotFailure = error instanceof Error ? error.message : "the page screenshot failed";
    screenshot = undefined;
  } finally {
    cleanupResult = await page.evaluate((key): IVisibilityIsolationCleanupResult => {
      // quality-allow: reads the state parked on the page's window under a private key.
      const state = (window as unknown as Record<string, IVisibilityIsolationState | undefined>)[key];
      if (state === undefined) return { cleaned: false, isolationIntact: false };
      let isolationIntact = true;
      try {
        state.mutationTracker.stop();
      } catch {
        isolationIntact = false;
      }
      if (state.mutationTracker.changed) isolationIntact = false;
      if (state.mutationTracker.domChanged) isolationIntact = false;
      const liveDocumentElement = document.documentElement ?? null;
      const liveElements = liveDocumentElement === null
        ? []
        : [liveDocumentElement, ...liveDocumentElement.querySelectorAll("*")];
      const domSnapshotIsIntact = state.domSnapshot.length === liveElements.length
        && state.domSnapshot.every(({ element, nextSibling, parent, previousSibling }, index) => {
          const liveElement = liveElements[index];
          return liveElement === element
            && element.parentElement === parent
            && element.previousSibling === previousSibling
            && element.nextSibling === nextSibling;
        });
      if (!domSnapshotIsIntact) isolationIntact = false;
      const target = state.elements[0] ?? null;
      const documentElement = document.documentElement ?? null;
      const body = document.body ?? null;
      if (target === null) isolationIntact = false;
      else {
        const targetContainsDocumentElement = target === documentElement || target.contains(documentElement);
        const targetContainsBody = target === body || target.contains(body);
        const transparentBackground = (element: Element | null): boolean => {
          if (element === null) return true;
          const style = window.getComputedStyle(element);
          return (style.backgroundColor === "transparent" || style.backgroundColor === "rgba(0, 0, 0, 0)")
            && style.backgroundImage === "none";
        };
        const isTargetElement = (element: Element): boolean => target === element || target.contains(element);
        const nonTargetElementsAreHidden = liveElements
          .filter((element) => !isTargetElement(element))
          .every((element) => window.getComputedStyle(element).visibility === "hidden");
        const rootsAreTransparent = (targetContainsDocumentElement || transparentBackground(documentElement))
          && (targetContainsBody || transparentBackground(body));
        if (window.getComputedStyle(target).visibility !== "visible"
          || window.getComputedStyle(state.probe).visibility !== "hidden"
          || !rootsAreTransparent
          || !nonTargetElementsAreHidden) isolationIntact = false;
      }
      for (const { element, properties } of state.hiddenElements) {
        try {
          const inlineStyle = (element as HTMLElement).style;
          for (const property of properties) {
            if (inlineStyle.getPropertyValue(property.name) === property.temporaryValue
              && inlineStyle.getPropertyPriority(property.name) === property.temporaryPriority) continue;
            isolationIntact = false;
          }
        } catch {
          isolationIntact = false;
        }
      }
      let cleaned = true;
      try {
        state.style.remove();
      } catch {
        cleaned = false;
      }
      for (const element of state.elements) {
        try {
          element.removeAttribute(state.markerAttribute);
        } catch {
          cleaned = false;
        }
      }
      for (const { element, properties } of state.hiddenElements) {
        try {
          const inlineStyle = (element as HTMLElement).style;
          for (const property of properties) {
            if (property.pageOwned) continue;
            if (inlineStyle.getPropertyValue(property.name) !== property.temporaryValue
              || inlineStyle.getPropertyPriority(property.name) !== property.temporaryPriority) continue;
            if (property.originalValue === "") inlineStyle.removeProperty(property.name);
            else inlineStyle.setProperty(property.name, property.originalValue, property.originalPriority);
          }
        } catch {
          cleaned = false;
        }
      }
      try {
        state.probe.removeAttribute(state.probeAttribute);
      } catch {
        cleaned = false;
      }
      try {
        state.probe.removeAttribute("style");
      } catch {
        cleaned = false;
      }
      try {
        state.probe.remove();
      } catch {
        cleaned = false;
      }
      try {
        // quality-allow: removes the state parked on the page's window under a private key.
        delete (window as unknown as Record<string, IVisibilityIsolationState | undefined>)[key];
      } catch {
        cleaned = false;
      }
      return { cleaned, isolationIntact };
    }, domSample.isolationKey).catch(() => undefined);
  }
  if (cleanupResult?.isolationIntact !== true) {
    throw new PlaytestBridgeError(playtestDiagnostic(
      "TN_PLAYTEST_OBSERVATION_UNAVAILABLE",
      "Temporary DOM visibility isolation changed while sampling; the rendered-pixel observation is unavailable.",
      "Keep page-owned visibility and root background styles stable while playtest sampling runs, then rerun the playtest.",
    ));
  }
  if (cleanupResult.cleaned !== true) {
    throw new PlaytestBridgeError(playtestDiagnostic(
      "TN_PLAYTEST_OBSERVATION_UNAVAILABLE",
      "Could not restore temporary DOM visibility isolation after sampling.",
      "Rerun the playtest after ensuring the target page permits temporary DOM attribute and style restoration.",
    ));
  }
  if (screenshotFailure !== undefined) {
    throw new PlaytestBridgeError(playtestDiagnostic(
      "TN_PLAYTEST_OBSERVATION_UNAVAILABLE",
      `Could not capture the isolated visibility screenshot: ${screenshotFailure}.`,
      "Rerun the playtest after ensuring the page renderer remains available for screenshot capture.",
    ));
  }
  if (screenshot === undefined) {
    throw new PlaytestBridgeError(playtestDiagnostic(
      "TN_PLAYTEST_OBSERVATION_UNAVAILABLE",
      "The isolated visibility screenshot was not produced.",
      "Rerun the playtest after ensuring the page renderer remains available for screenshot capture.",
    ));
  }
  let rendered: boolean;
  try {
    rendered = containsPaintedPixels(screenshot);
  } catch (error) {
    const reason = error instanceof Error ? error.message : "the PNG could not be decoded";
    throw new PlaytestBridgeError(playtestDiagnostic(
      "TN_PLAYTEST_OBSERVATION_UNAVAILABLE",
      `Could not decode the isolated visibility screenshot: ${reason}.`,
      "Rerun the playtest after ensuring screenshot capture returns a valid PNG.",
    ));
  }
  return {
    bounds: domSample.bounds,
    rendered,
  };
}

function containsPaintedPixels(screenshot: Buffer): boolean {
  const png = PNG.sync.read(screenshot);
  for (let offset = 0; offset < png.data.length; offset += 4) {
    if ((png.data[offset + 3] ?? 0) > 0) return true;
  }
  return false;
}

/**
 * Reads every visible text element the page draws, with its colour and the colour behind it.
 *
 * The DOM is the only place a HUD's real text lives: a canvas pixel cannot say whether "NaN"
 * reached the player. A background is composited from the nearest ancestor up so text on the
 * canvas reports alpha 0 and is not judged against a colour the player never sees.
 */
export async function sampleHudAudit(page: Page): Promise<{ items: IPlaytestHudAuditItem[] }> {
  return page.evaluate((): { items: IPlaytestHudAuditItem[] } => {
    const MAX_ITEMS = 400;
    const MAX_TEXT = 120;

    const parseColour = (value: string): [number, number, number, number] => {
      const match = /^rgba?\((.+)\)$/u.exec(value.trim());
      if (match !== null) {
        const parts = match[1]!.split(/[\s,/]+/u).filter((part) => part !== "");
        const channels = parts.slice(0, 3).map((part) => Number.parseFloat(part));
        const alphaText = parts[3];
        const alpha = alphaText === undefined ? 1 : Number.parseFloat(alphaText);
        const normalizedAlpha = alpha > 1 ? alpha / 255 : alpha;
        if (channels.length === 3 && channels.every((channel) => Number.isFinite(channel)) && Number.isFinite(normalizedAlpha)) {
          return [channels[0]!, channels[1]!, channels[2]!, Math.min(Math.max(normalizedAlpha, 0), 1)];
        }
      }
      const canvas = document.createElement("canvas");
      canvas.width = 1;
      canvas.height = 1;
      const context = canvas.getContext("2d", { willReadFrequently: true });
      if (context === null) return [0, 0, 0, 1];
      context.clearRect(0, 0, 1, 1);
      context.fillStyle = value;
      context.fillRect(0, 0, 1, 1);
      const data = context.getImageData(0, 0, 1, 1).data;
      return [data[0]!, data[1]!, data[2]!, data[3]! / 255];
    };

    const backing = (element: Element): [number, number, number, number] => {
      let accumulated: [number, number, number, number] = [0, 0, 0, 0];
      for (let current: Element | null = element; current !== null; current = current.parentElement) {
        const [r, g, b, a] = parseColour(window.getComputedStyle(current).backgroundColor);
        // Each ancestor paints underneath what is already accumulated: the nearer plate stays on top.
        if (a > 0 && accumulated[3] < 0.99) {
          const near = accumulated[3];
          const total = near + a * (1 - near);
          if (total > 0) {
            accumulated = [
              (accumulated[0] * near + r * a * (1 - near)) / total,
              (accumulated[1] * near + g * a * (1 - near)) / total,
              (accumulated[2] * near + b * a * (1 - near)) / total,
              total,
            ];
          }
        }
        if (accumulated[3] >= 0.99 || current === document.documentElement) break;
      }
      return accumulated;
    };

    const items: IPlaytestHudAuditItem[] = [];
    for (const element of document.body.querySelectorAll("*")) {
      if (items.length === MAX_ITEMS) break;
      if (element.closest("script, style, canvas, noscript") !== null) continue;
      let ownText = "";
      for (const node of element.childNodes) {
        if (node.nodeType === 3 /* Node.TEXT_NODE; the global is browser-only */) ownText += node.textContent ?? "";
      }
      const text = ownText.replace(/\s+/gu, " ").trim();
      if (text === "") continue;
      const style = window.getComputedStyle(element);
      if (style.display === "none" || style.visibility !== "visible") continue;
      const opacity = Number.parseFloat(style.opacity);
      if (!Number.isFinite(opacity) || opacity <= 0) continue;
      const rect = element.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) continue;
      if (rect.right <= 0 || rect.bottom <= 0 || rect.left >= window.innerWidth || rect.top >= window.innerHeight) continue;
      const classes = Array.from(element.classList).slice(0, 2).map((name) => `.${name}`).join("");
      items.push({
        background: backing(element),
        color: parseColour(style.color),
        fontSizePx: Number.parseFloat(style.fontSize),
        selector: `${element.tagName.toLowerCase()}${element.id === "" ? "" : `#${element.id}`}${classes}`,
        text: text.slice(0, MAX_TEXT),
      });
    }
    return { items };
  });
}

export async function sampleHud(page: Page, assertions: readonly IPlaytestPathAssertion[]): Promise<Record<string, unknown>> {
  if (assertions.length === 0) return {};
  const snapshots: Record<string, unknown> = await page.evaluate((requestedAssertions) => Object.fromEntries(requestedAssertions.flatMap(({ id, path }) => {
    const element = path === undefined
      ? document.getElementById(id)
      : (() => {
          try {
            return document.querySelector(path);
          } catch {
            return null;
          }
        })();
    if (element === null) return [];
    const text = element.textContent?.trim() ?? "";
    const rawValue = element.getAttribute("data-value");
    const value = rawValue === null ? undefined : Number.isFinite(Number(rawValue)) ? Number(rawValue) : rawValue;
    const snapshot = value === undefined ? text : value;
    return [[id, path === undefined ? snapshot : { [path]: snapshot }] as const];
  })), assertions);
  for (const assertion of assertions) {
    if (assertion.visible === undefined || !Object.hasOwn(snapshots, assertion.id)) continue;
    const visibility = await sampleElementVisibility(
      page,
      assertion.path === undefined ? { id: assertion.id } : { selector: assertion.path },
    );
    const snapshot = snapshots[assertion.id];
    if (assertion.path === undefined) {
      snapshots[assertion.id] = { text: snapshot, visible: visibility.rendered };
      continue;
    }
    const pathSnapshot = typeof snapshot === "object" && snapshot !== null && !Array.isArray(snapshot)
      ? (snapshot as Record<string, unknown>)[assertion.path]
      : snapshot;
    snapshots[assertion.id] = { [assertion.path]: { text: pathSnapshot, visible: visibility.rendered } };
  }
  return snapshots;
}
