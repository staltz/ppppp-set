declare module 'obz' {
  type Remove = () => void
  export interface Obz<X> {
    (listener: (value: X) => void): Remove
    set(value: X): unknown
    value: X
  }
  function createObz(): Obz
  export = createObz
}