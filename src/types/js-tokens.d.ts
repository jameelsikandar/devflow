declare module 'js-tokens' {
  const pattern: RegExp;
  export default pattern;
  export function matchToToken(match: RegExpExecArray): {
    type: string;
    value: string;
    closed?: boolean;
  };
}
