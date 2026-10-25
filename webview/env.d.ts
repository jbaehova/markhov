// The webview imports CSS for its side effects; the extension imports it as text.
declare module '*.css' {
  const text: string;
  export default text;
}
