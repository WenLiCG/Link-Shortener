import { domainFilterAction, type DomainFilters } from "../src/app/src/domain-filters";
import { expect, it } from "vitest";

function emptyFilters(): DomainFilters {
  return { search: "", groupId: "", status: "", days: "", visitedFrom: "", visitedTo: "" };
}

it("requires applying a changed draft before offering reset", () => {
  const initial = emptyFilters();
  const dateRange = { ...initial, visitedFrom: "2026-08-01", visitedTo: "2026-08-25" };

  expect(domainFilterAction(dateRange, initial)).toBe("apply");
  expect(domainFilterAction(dateRange, dateRange)).toBe("reset");
  expect(domainFilterAction({ ...dateRange, search: "example" }, dateRange)).toBe("apply");
});

it("keeps the initial unfiltered list ready to filter", () => {
  expect(domainFilterAction(emptyFilters(), emptyFilters())).toBe("apply");
});
