// Minimal React typings: @types/react is not available in this offline build
// environment. Hooks are typed; JSX elements are permissive.
declare module 'react' {
  export type ReactNode = any;
  export type ReactElement = any;
  export type FC<P = {}> = (props: P & { children?: ReactNode }) => ReactNode;
  export type Dispatch<A> = (value: A) => void;
  export type SetStateAction<S> = S | ((prev: S) => S);
  export interface RefObject<T> { current: T }
  export interface MutableRefObject<T> { current: T }
  export type DependencyList = readonly unknown[];
  export type CSSProperties = Record<string, string | number | undefined>;
  export interface SVGAttributes<T> { [attr: string]: any; _t?: T }
  export interface HTMLAttributes<T> { [attr: string]: any; _t?: T }
  export type JSX = any;
  export type KeyboardEvent<T = Element> = globalThis.KeyboardEvent & { currentTarget: T; target: EventTarget };
  export type MouseEvent<T = Element> = globalThis.MouseEvent & { currentTarget: T };
  export type ChangeEvent<T = Element> = Event & { target: T; currentTarget: T };
  export type FormEvent<T = Element> = Event & { currentTarget: T };
  export type ClipboardEvent<T = Element> = globalThis.ClipboardEvent & { currentTarget: T };
  export type DragEvent<T = Element> = globalThis.DragEvent & { currentTarget: T };
  export type UIEvent<T = Element> = Event & { currentTarget: T };

  export function useState<S>(initial: S | (() => S)): [S, Dispatch<SetStateAction<S>>];
  export function useState<S = undefined>(): [S | undefined, Dispatch<SetStateAction<S | undefined>>];
  export function useEffect(fn: () => void | (() => void), deps?: DependencyList): void;
  export function useLayoutEffect(fn: () => void | (() => void), deps?: DependencyList): void;
  export function useRef<T>(initial: T): MutableRefObject<T>;
  export function useRef<T>(initial: T | null): RefObject<T | null>;
  export function useRef<T = undefined>(): MutableRefObject<T | undefined>;
  export function useMemo<T>(fn: () => T, deps: DependencyList): T;
  export function useCallback<T extends (...args: any[]) => any>(fn: T, deps: DependencyList): T;
  export function useSyncExternalStore<T>(subscribe: (cb: () => void) => () => void, get: () => T, getServer?: () => T): T;
  export function useId(): string;
  export function useReducer<S, A>(r: (s: S, a: A) => S, init: S): [S, Dispatch<A>];
  export interface Context<T> { Provider: any; Consumer: any; _t?: T }
  export function createContext<T>(v: T): Context<T>;
  export function useContext<T>(c: Context<T>): T;
  export function memo<T>(c: T, eq?: (a: any, b: any) => boolean): T;
  export function forwardRef<T, P = {}>(fn: (props: P, ref: any) => ReactNode): FC<P & { ref?: any }>;
  export function lazy<T>(fn: () => Promise<{ default: T }>): T;
  export function startTransition(fn: () => void): void;
  export function useTransition(): [boolean, (fn: () => void) => void];
  export function useDeferredValue<T>(v: T): T;
  export const Fragment: any;
  export const StrictMode: any;
  export const Suspense: any;
  export class Component<P = {}, S = {}> { props: P & { children?: ReactNode }; state: S; constructor(p: P); setState(s: Partial<S>): void; render(): ReactNode }
  const React: any;
  export default React;
}
declare module 'react-dom/client' {
  export function createRoot(el: Element): { render(node: any): void; unmount(): void };
}
declare module 'react-dom' {
  export function createPortal(node: any, el: Element): any;
  export function flushSync(fn: () => void): void;
}
declare module 'react/jsx-runtime' {
  export const jsx: any; export const jsxs: any; export const Fragment: any;
}
declare namespace JSX {
  interface IntrinsicElements { [el: string]: any }
  interface Element {}
  interface ElementChildrenAttribute { children: {} }
  interface IntrinsicAttributes { key?: string | number | null }
}
