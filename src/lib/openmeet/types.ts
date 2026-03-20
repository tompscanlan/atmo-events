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
	atprotoUri: string | null;
	group: OpenMeetEventGroup | null;
	attendeesCount: number;
	userRsvpStatus: string | null;
	image: string | null;
}

export interface OpenMeetTokens {
	token: string;
}
