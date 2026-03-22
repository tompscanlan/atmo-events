export interface OpenMeetGroup {
	slug: string;
	name: string;
	description: string;
	visibility: string;
	role: string;
	memberCount: number;
	upcomingEventCount: number;
	image: string | null;
}

export interface OpenMeetEventGroup {
	slug: string;
	name: string;
	role: string;
}

export interface OpenMeetPhoto {
	path: string;
}

export interface OpenMeetUser {
	slug: string;
	name: string;
	provider: string;
	socialId: string | null;
	isShadowAccount: boolean;
	photo: OpenMeetPhoto | null;
}

export interface OpenMeetEventRole {
	id: number;
	name: string;
}

export interface OpenMeetAttendee {
	id: number;
	status: string;
	role: OpenMeetEventRole | null;
	user: OpenMeetUser;
}

export interface OpenMeetCategory {
	id: number;
	name: string;
	slug: string;
}

export interface OpenMeetEvent {
	slug: string;
	name: string;
	description: string;
	startDate: string;
	endDate: string | null;
	location: string | null;
	locationOnline: string | null;
	type: string;
	visibility: string;
	status: string;
	timeZone: string | null;
	maxAttendees: number;
	atprotoUri: string | null;
	group: OpenMeetEventGroup | null;
	user: OpenMeetUser | null;
	attendees: OpenMeetAttendee[];
	attendeesCount: number;
	userRsvpStatus: string | null;
	categories: OpenMeetCategory[];
	image: string | null;
	lat: number | null;
	lon: number | null;
}

export interface OpenMeetTokens {
	token: string;
}
