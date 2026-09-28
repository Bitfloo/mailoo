// Without an import, this file shadows vitest instead of extending it.
import 'vitest';

declare module 'vitest' {
  export interface ProvidedContext {
    greenmailHost: string;
    greenmailSmtpPort: number;
    greenmailSmtpsPort: number;
    greenmailImapPort: number;
    greenmailImapsPort: number;
  }
}
