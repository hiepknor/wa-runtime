import { Module } from '@nestjs/common';
import { OpenWAClient } from './openwa.client';

@Module({ providers: [OpenWAClient], exports: [OpenWAClient] })
export class OpenWAModule {}
