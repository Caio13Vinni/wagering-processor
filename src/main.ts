import 'reflect-metadata';
import { orm } from './config/orm'; // inicializa o ORM antes de qualquer coisa
import { NestFactory } from '@nestjs/core';
import { ValidationPipe } from '@nestjs/common';
import { AppModule } from './app.module';
import { env } from './config/env';
import { JwtAuthGuard } from './infrastructure/auth/jwt-auth.guard';

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

if (env.auth.enabled) {
  app.useGlobalGuards(new JwtAuthGuard());
  console.log(JSON.stringify({ msg: 'auth enabled', issuer: env.auth.issuerUrl }));
}

await app.listen(env.port);
console.log(JSON.stringify({ msg: 'listening', port: env.port }));