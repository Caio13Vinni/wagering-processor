import 'reflect-metadata';
import { orm } from './config/orm'; // inicializa o ORM antes de qualquer coisa
import { NestFactory } from '@nestjs/core';
import { ValidationPipe } from '@nestjs/common';
import { AppModule } from './app.module';
import { env } from './config/env';

void orm; // referência garante inicialização antes do Nest

const app = await NestFactory.create(AppModule);
app.enableShutdownHooks();
app.useGlobalPipes(
  new ValidationPipe({
    whitelist: true,
    transform: true,
    forbidNonWhitelisted: true,
  }),
);
await app.listen(env.port);
console.log(JSON.stringify({ msg: 'listening', port: env.port }));