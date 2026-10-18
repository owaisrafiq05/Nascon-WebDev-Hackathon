import { asRecord, asString, providerFetch, type ErrorExtractor } from '../http.js';

/**
 * Google Calendar through OAuth 2.0 (I3).
 *
 * The platform owns one OAuth client; each employee grants their own consent and
 * gets their own connection (I3.1). Refresh and access tokens never leave the
 * server (I3.2).
 */
export interface GoogleOAuthClient {
  readonly clientId: string;
  readonly clientSecret: string;
  readonly redirectUri: string;
}

export interface GoogleTokens {
  readonly accessToken: string;
  readonly refreshToken: string | null;
  readonly expiresAt: Date;
}

export interface BusyInterval {
  readonly start: Date;
  readonly end: Date;
}

export interface CalendarEventInput {
  readonly summary: string;
  readonly description: string;
  readonly startsAt: Date;
  readonly endsAt: Date;
  readonly timeZone: string;
}

export interface CalendarProvider {
  authorizationUrl(client: GoogleOAuthClient, state: string): string;
  exchangeCode(client: GoogleOAuthClient, code: string): Promise<GoogleTokens>;
  refresh(client: GoogleOAuthClient, refreshToken: string): Promise<GoogleTokens>;
  revoke(token: string): Promise<void>;
  profile(accessToken: string): Promise<{ email: string; timeZone: string }>;
  busy(accessToken: string, calendarId: string, from: Date, to: Date): Promise<BusyInterval[]>;
  createEvent(
    accessToken: string,
    calendarId: string,
    event: CalendarEventInput,
  ): Promise<{ id: string; htmlLink: string | null }>;
  updateEvent(
    accessToken: string,
    calendarId: string,
    eventId: string,
    event: CalendarEventInput,
  ): Promise<void>;
  deleteEvent(accessToken: string, calendarId: string, eventId: string): Promise<void>;
}

export const GOOGLE_SCOPES = [
  'https://www.googleapis.com/auth/calendar.events',
  'https://www.googleapis.com/auth/calendar.readonly',
  'openid',
  'email',
];

const googleError: ErrorExtractor = (body) => {
  const record = asRecord(body);
  // OAuth endpoints answer { error, error_description }; APIs { error: { message } }.
  const oauthError = asString(record['error']);
  if (oauthError !== undefined) {
    return { code: oauthError, message: asString(record['error_description']) ?? oauthError };
  }
  const apiError = asRecord(record['error']);
  const message = asString(apiError['message']);
  const status = asString(apiError['status']);
  return {
    ...(message === undefined ? {} : { message }),
    ...(status === undefined ? {} : { code: status }),
  };
};

function tokensFrom(body: unknown, now = Date.now()): GoogleTokens {
  const record = asRecord(body);
  const expiresIn = typeof record['expires_in'] === 'number' ? record['expires_in'] : 3_600;
  return {
    accessToken: asString(record['access_token']) ?? '',
    refreshToken: asString(record['refresh_token']) ?? null,
    expiresAt: new Date(now + expiresIn * 1_000),
  };
}

function bearer(token: string): Record<string, string> {
  return { Authorization: `Bearer ${token}` };
}

function eventBody(event: CalendarEventInput): Record<string, unknown> {
  return {
    summary: event.summary,
    description: event.description,
    // An explicit instant plus its zone: unambiguous, and shown in the zone (I3.5).
    start: { dateTime: event.startsAt.toISOString(), timeZone: event.timeZone },
    end: { dateTime: event.endsAt.toISOString(), timeZone: event.timeZone },
  };
}

const CALENDAR_API = 'https://www.googleapis.com/calendar/v3';

export const googleCalendarProvider: CalendarProvider = {
  authorizationUrl(client, state) {
    const params = new URLSearchParams({
      client_id: client.clientId,
      redirect_uri: client.redirectUri,
      response_type: 'code',
      scope: GOOGLE_SCOPES.join(' '),
      access_type: 'offline',
      // Forces a refresh token on every consent, including a reconnect.
      prompt: 'consent',
      include_granted_scopes: 'true',
      state,
    });
    return `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`;
  },

  async exchangeCode(client, code) {
    const { body } = await providerFetch(
      {
        method: 'POST',
        url: 'https://oauth2.googleapis.com/token',
        form: {
          code,
          client_id: client.clientId,
          client_secret: client.clientSecret,
          redirect_uri: client.redirectUri,
          grant_type: 'authorization_code',
        },
      },
      googleError,
    );
    return tokensFrom(body);
  },

  async refresh(client, refreshToken) {
    const { body } = await providerFetch(
      {
        method: 'POST',
        url: 'https://oauth2.googleapis.com/token',
        form: {
          refresh_token: refreshToken,
          client_id: client.clientId,
          client_secret: client.clientSecret,
          grant_type: 'refresh_token',
        },
      },
      googleError,
    );
    return tokensFrom(body);
  },

  async revoke(token) {
    await providerFetch(
      { method: 'POST', url: 'https://oauth2.googleapis.com/revoke', form: { token } },
      googleError,
    );
  },

  async profile(accessToken) {
    const [{ body: info }, { body: setting }] = await Promise.all([
      providerFetch(
        {
          method: 'GET',
          url: 'https://openidconnect.googleapis.com/v1/userinfo',
          headers: bearer(accessToken),
        },
        googleError,
      ),
      providerFetch(
        {
          method: 'GET',
          url: `${CALENDAR_API}/users/me/settings/timezone`,
          headers: bearer(accessToken),
        },
        googleError,
      ),
    ]);
    return {
      email: asString(asRecord(info)['email']) ?? '',
      timeZone: asString(asRecord(setting)['value']) ?? 'UTC',
    };
  },

  async busy(accessToken, calendarId, from, to) {
    const { body } = await providerFetch(
      {
        method: 'POST',
        url: `${CALENDAR_API}/freeBusy`,
        headers: bearer(accessToken),
        json: {
          timeMin: from.toISOString(),
          timeMax: to.toISOString(),
          items: [{ id: calendarId }],
        },
      },
      googleError,
    );
    const calendars = asRecord(asRecord(body)['calendars']);
    const busy = asRecord(calendars[calendarId])['busy'];
    if (!Array.isArray(busy)) return [];
    return busy.map((entry) => {
      const record = asRecord(entry);
      return {
        start: new Date(asString(record['start']) ?? 0),
        end: new Date(asString(record['end']) ?? 0),
      };
    });
  },

  async createEvent(accessToken, calendarId, event) {
    const { body } = await providerFetch(
      {
        method: 'POST',
        url: `${CALENDAR_API}/calendars/${encodeURIComponent(calendarId)}/events`,
        headers: bearer(accessToken),
        json: eventBody(event),
      },
      googleError,
    );
    const record = asRecord(body);
    return { id: asString(record['id']) ?? '', htmlLink: asString(record['htmlLink']) ?? null };
  },

  async updateEvent(accessToken, calendarId, eventId, event) {
    await providerFetch(
      {
        method: 'PATCH',
        url: `${CALENDAR_API}/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(eventId)}`,
        headers: bearer(accessToken),
        json: eventBody(event),
      },
      googleError,
    );
  },

  async deleteEvent(accessToken, calendarId, eventId) {
    await providerFetch(
      {
        method: 'DELETE',
        url: `${CALENDAR_API}/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(eventId)}`,
        headers: bearer(accessToken),
      },
      googleError,
    );
  },
};
