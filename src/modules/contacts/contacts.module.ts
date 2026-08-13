import { Module } from '@nestjs/common';
import { ContactRepository } from './contact.repository';

@Module({ providers: [ContactRepository], exports: [ContactRepository] })
export class ContactsModule {}

