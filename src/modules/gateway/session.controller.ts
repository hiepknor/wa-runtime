import { Controller, Get, HttpCode, NotFoundException, Param, ParseUUIDPipe, Post } from '@nestjs/common';
import { ApiAcceptedResponse, ApiOkResponse, ApiOperation, ApiSecurity, ApiTags } from '@nestjs/swagger';
import { SessionDto, SessionListDto } from '../../contracts/sessions/session.dto';
import { SyncRunDto } from '../../contracts/sessions/sync-run.dto';
import { GatewayRepository } from './gateway.repository';
import { GatewaySyncService } from './gateway-sync.service';
import { SessionService } from './session.service';

@ApiTags('sessions')
@ApiSecurity('runtime-key')
@Controller('sessions')
export class SessionController {
  constructor(
    private readonly sessions: SessionService,
    private readonly sync: GatewaySyncService,
    private readonly repository: GatewayRepository,
  ) {}

  @Get()
  @ApiOperation({ summary: 'List allowlisted Gateway sessions' })
  @ApiOkResponse({ type: SessionListDto })
  list() { return this.sessions.list(); }

  @Get(':id')
  @ApiOperation({ summary: 'Read a Gateway session from the durable read model' })
  @ApiOkResponse({ type: SessionDto })
  get(@Param('id', ParseUUIDPipe) id: string) { return this.sessions.get(id); }

  @Post(':id/sync')
  @HttpCode(202)
  @ApiOperation({ summary: 'Queue a full session, group and group-member sync' })
  @ApiAcceptedResponse({ type: SyncRunDto })
  requestSync(@Param('id', ParseUUIDPipe) id: string) { return this.sync.request(id); }

  @Get(':id/sync-runs/:runId')
  @ApiOperation({ summary: 'Read sync progress' })
  @ApiOkResponse({ type: SyncRunDto })
  async getSyncRun(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('runId', ParseUUIDPipe) runId: string,
  ) {
    const run = await this.repository.findSyncRun(runId);
    if (!run || run.sessionId !== id) throw new NotFoundException('Sync run not found');
    return run;
  }
}
