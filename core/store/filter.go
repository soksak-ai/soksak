package store

import (
	"encoding/json"
	"fmt"
	"sort"
	"strings"

	"github.com/soksak/soksak-core/core/i18n"
)

// The one where-clause builder, shared by data_query and data_count.
//
// One builder, because two would drift and the drift shows as a count that
// disagrees with the list it counts.

// The built-in fields are real columns on records, so they are addressable
// without being declared: id is the primary key, created and updated are the
// timestamps.
func isBuiltInField(field string) bool {
	return field == "id" || field == "created" || field == "updated"
}

// fieldExpression turns a field into the SQL that reads it. Everything not
// built in is a document field, reachable only through json_extract — and only
// if the collection declared an index for it, which is what keeps this
// interpolation to names a rule has already vetted.
func fieldExpression(field string) string {
	if isBuiltInField(field) {
		return field
	}
	return fmt.Sprintf("json_extract(doc, '$.%s')", field)
}

// bindValue turns one JSON scalar into what the driver should bind.
//
// json_extract answers booleans as 1/0, numbers as numbers and text as text, so
// the binding matches that shape rather than JSON's. A value that is neither
// scalar nor null binds as its JSON text, which compares equal to nothing and
// is therefore an honest miss rather than a silent match.
func bindValue(raw json.RawMessage) any {
	var value any
	if err := json.Unmarshal(raw, &value); err != nil {
		return string(raw)
	}
	switch typed := value.(type) {
	case nil:
		return nil
	case bool:
		if typed {
			return int64(1)
		}
		return int64(0)
	case float64:
		if typed == float64(int64(typed)) {
			return int64(typed)
		}
		return typed
	case string:
		return typed
	default:
		return string(raw)
	}
}

// A condition is either a bare scalar (equality) or {op, value}.
type condition struct {
	Op    string          `json:"op"`
	Value json.RawMessage `json:"value"`
}

func readCondition(raw json.RawMessage) condition {
	var probe map[string]json.RawMessage
	if err := json.Unmarshal(raw, &probe); err == nil {
		if _, present := probe["op"]; present {
			parsed := condition{Op: "eq", Value: json.RawMessage("null")}
			if err := json.Unmarshal(raw, &parsed); err == nil {
				if parsed.Op == "" {
					parsed.Op = "eq"
				}
				if parsed.Value == nil {
					parsed.Value = json.RawMessage("null")
				}
				return parsed
			}
		}
	}
	return condition{Op: "eq", Value: raw}
}

var comparisons = map[string]string{
	"eq": "=", "ne": "!=", "lt": "<", "lte": "<=", "gt": ">", "gte": ">=", "like": "LIKE",
}

// buildWhere compiles a filter into a clause to append and the values to bind.
//
// Fields are sorted by name first. Go randomises map iteration, so without that
// the same filter compiles into a different statement on every call: the
// prepared-statement cache never hits, and nothing can be asserted about what
// was built. An ordered map iterated map and never had to say this.
//
// A field that is neither built in nor declared as an index is refused by name.
// That refusal does two jobs: it keeps every interpolated identifier one a rule
// has vetted, and it blocks a full scan of records from being one typo away.
func buildWhere(filter map[string]json.RawMessage, allowed []string) (string, []any, error) {
	if len(filter) == 0 {
		return "", nil, nil
	}
	fields := make([]string, 0, len(filter))
	for field := range filter {
		fields = append(fields, field)
	}
	sort.Strings(fields)

	declared := make(map[string]struct{}, len(allowed))
	for _, field := range allowed {
		declared[field] = struct{}{}
	}

	clauses := make([]string, 0, len(fields))
	params := make([]any, 0, len(fields))
	for _, field := range fields {
		if err := validateField(field); err != nil {
			return "", nil, err
		}
		if _, ok := declared[field]; !ok && !isBuiltInField(field) {
			return "", nil, i18n.Errorf("store.filter.fieldNotIndexed", map[string]string{"field": field})
		}
		expression := fieldExpression(field)
		parsed := readCondition(filter[field])

		if operator, known := comparisons[parsed.Op]; known {
			clauses = append(clauses, fmt.Sprintf("%s %s ?", expression, operator))
			params = append(params, bindValue(parsed.Value))
			continue
		}
		if parsed.Op != "in" {
			return "", nil, i18n.Errorf("store.filter.unknownOperator", map[string]string{"operator": parsed.Op, "field": field})
		}
		var members []json.RawMessage
		if err := json.Unmarshal(parsed.Value, &members); err != nil {
			return "", nil, i18n.Errorf("store.filter.inValueNotArray", map[string]string{"field": field})
		}
		if len(members) == 0 {
			// The constant false. Collapsing an empty `in` to "no filter" turns
			// "match nothing" into "match everything".
			clauses = append(clauses, "0")
			continue
		}
		marks := strings.TrimSuffix(strings.Repeat("?,", len(members)), ",")
		clauses = append(clauses, fmt.Sprintf("%s IN (%s)", expression, marks))
		for _, member := range members {
			params = append(params, bindValue(member))
		}
	}
	return " AND " + strings.Join(clauses, " AND "), params, nil
}

// orderExpression validates an order field against the same whitelist, so a
// sort cannot reach a column a filter could not.
func orderExpression(order string, allowed []string) (string, error) {
	if order == "" {
		order = "updated"
	}
	if err := validateField(order); err != nil {
		return "", err
	}
	if !isBuiltInField(order) {
		found := false
		for _, field := range allowed {
			if field == order {
				found = true
				break
			}
		}
		if !found {
			return "", i18n.Errorf("store.order.fieldNotIndexed", map[string]string{"field": order})
		}
	}
	return fieldExpression(order), nil
}
