// Runtime subpath avoids importing cron-parser's filesystem-only CronFileParser.
declare module "cron-parser/dist/CronExpressionParser" {
  export { CronExpressionParser } from "cron-parser";
}
