export class Logger {
  static DEBUG = false;
  static log(...args: any[]) {
    if (Logger.DEBUG) {
      // eslint-disable-next-line no-console
      console.log(...args);
    }
  }
}
