import { Body, Controller, Get, HttpCode, NotFoundException, Param, ParseUUIDPipe, Post } from '@nestjs/common';
import { ApiAcceptedResponse, ApiBody, ApiConflictResponse, ApiOkResponse, ApiOperation, ApiSecurity, ApiTags } from '@nestjs/swagger';
import { SessionDto, SessionListDto } from '../../contracts/sessions/session.dto';
import { SyncRunDto } from '../../contracts/sessions/sync-run.dto';
import { SyncRequestDto } from '../../contracts/sessions/sync-request.dto';
import { SyncModeConflictDto } from '../../contracts/sessions/sync-mode-conflict.dto';
import { GatewayRepository } from './gateway.repository';
import { GatewaySyncService } from './gateway-sync.service';
import { SessionService } from './session.service';
import { SessionScopeService } from './session-scope.service';

@ApiTags('sessions')
@ApiSecurity('runtime-key')
@Controller('sessions')
export class SessionController {
  constructor(
    private readonly sessions: SessionService,
    private readonly sync: GatewaySyncService,
    private readonly repository: GatewayRepository,
    private readonly sessionScope: SessionScopeService,
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
  @ApiOperation({ summary: 'Queue durable discovery and group reconciliation' })
  @ApiBody({ type: SyncRequestDto, required: false })
  @ApiAcceptedResponse({ type: SyncRunDto })
  @ApiConflictResponse({ type: SyncModeConflictDto, description: 'A different sync mode is already active' })
  requestSync(@Param('id', ParseUUIDPipe) id: string, @Body() request: SyncRequestDto = new SyncRequestDto()) {
    return this.sync.request(id, request.mode);
  }

  @Get(':id/sync-runs/:runId')
  @ApiOperation({ summary: 'Read sync progress' })
  @ApiOkResponse({ type: SyncRunDto })
  async getSyncRun(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('runId', ParseUUIDPipe) runId: string,
  ) {
    this.sessionScope.assertVisible(id);
    const run = await this.repository.findSyncRun(runId);
    if (!run || run.sessionId !== id) throw new NotFoundException('Sync run not found');
    return run;
  }
}
