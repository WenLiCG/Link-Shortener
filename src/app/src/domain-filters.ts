export interface DomainFilters {
  search: string;
  groupId: string;
  status: string;
  days: string;
  visitedFrom: string;
  visitedTo: string;
}

export function emptyDomainFilters(): DomainFilters {
  return { search: "", groupId: "", status: "", days: "", visitedFrom: "", visitedTo: "" };
}

export function domainFilterAction(draft: DomainFilters, applied: DomainFilters): "apply" | "reset" {
  const same = draft.search === applied.search
    && draft.groupId === applied.groupId
    && draft.status === applied.status
    && draft.days === applied.days
    && draft.visitedFrom === applied.visitedFrom
    && draft.visitedTo === applied.visitedTo;
  return same && Object.values(applied).some(Boolean) ? "reset" : "apply";
}
