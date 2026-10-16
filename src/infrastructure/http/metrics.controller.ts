import { Controller, Get } from '@nestjs/common';
import { metrics } from '../metrics/metrics';

@Controller('metrics')
export class MetricsController {
  @Get()
  get() {
    return metrics.snapshot();
  }
}
