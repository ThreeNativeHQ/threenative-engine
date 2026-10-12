// three's ShapeUtils and mapbox/earcut 3.0.2 (three@0.185.1 src/extras/lib/earcut.js), ported
// operation for operation: the same node walk, the same z-order hash and the same stable hole sort,
// so the triangles come out in three's order.

#include "engine/scene/shape_utils.h"

#include <algorithm>
#include <cmath>
#include <deque>
#include <limits>
#include <stdexcept>

namespace tn::engine {

namespace {

struct Node {
    uint32_t i;
    double x, y;
    Node* prev = nullptr;
    Node* next = nullptr;
    int32_t z = 0;
    Node* prevZ = nullptr;
    Node* nextZ = nullptr;
    bool steiner = false;
};

/** JavaScript's ToInt32, which `| 0` applies. */
int32_t toInt32(double v) {
    if (!std::isfinite(v)) return 0;
    const double m = std::fmod(std::trunc(v), 4294967296.0);
    const auto u = static_cast<uint32_t>(static_cast<int64_t>(m < 0 ? m + 4294967296.0 : m));
    return static_cast<int32_t>(u);
}

class Earcut {
public:
    explicit Earcut(const std::vector<double>& data) : data_(data) {}

    std::vector<uint32_t> run(const std::vector<uint32_t>& holeIndices) {
        const bool hasHoles = !holeIndices.empty();
        const size_t outerLen = hasHoles ? size_t(holeIndices[0]) * 2 : data_.size();
        Node* outerNode = linkedList(0, outerLen, true);
        if (!outerNode || outerNode->next == outerNode->prev) return triangles_;
        if (hasHoles) outerNode = eliminateHoles(holeIndices, outerNode);
        double minX = 0, minY = 0, invSize = 0;
        if (data_.size() > 80 * 2) {
            minX = data_[0];
            minY = data_[1];
            double maxX = minX;
            double maxY = minY;
            for (size_t i = 2; i < outerLen; i += 2) {
                const double x = data_[i];
                const double y = data_[i + 1];
                if (x < minX) minX = x;
                if (y < minY) minY = y;
                if (x > maxX) maxX = x;
                if (y > maxY) maxY = y;
            }
            invSize = std::max(maxX - minX, maxY - minY);
            invSize = invSize != 0 ? 32767 / invSize : 0;
        }
        earcutLinked(outerNode, minX, minY, invSize, 0);
        return triangles_;
    }

private:
    const std::vector<double>& data_;
    std::deque<Node> nodes_;
    std::vector<uint32_t> triangles_;

    double signedArea(size_t start, size_t end) const {
        double sum = 0;
        for (size_t i = start, j = end - 2; i < end; i += 2) {
            sum += (data_[j] - data_[i]) * (data_[i + 1] + data_[j + 1]);
            j = i;
        }
        return sum;
    }

    Node* linkedList(size_t start, size_t end, bool clockwise) {
        Node* last = nullptr;
        if (start >= end) return nullptr;
        if (clockwise == (signedArea(start, end) > 0)) {
            for (size_t i = start; i < end; i += 2) last = insertNode(uint32_t(i / 2), data_[i], data_[i + 1], last);
        } else {
            for (size_t i = end - 2;; i -= 2) {
                last = insertNode(uint32_t(i / 2), data_[i], data_[i + 1], last);
                if (i == start) break;
            }
        }
        if (last && equals(last, last->next)) {
            removeNode(last);
            last = last->next;
        }
        return last;
    }

    static Node* filterPoints(Node* start, Node* end = nullptr) {
        if (!start) return start;
        if (!end) end = start;
        Node* p = start;
        bool again;
        do {
            again = false;
            if (!p->steiner && (equals(p, p->next) || area(p->prev, p, p->next) == 0)) {
                removeNode(p);
                p = end = p->prev;
                if (p == p->next) break;
                again = true;
            } else {
                p = p->next;
            }
        } while (again || p != end);
        return end;
    }

    void earcutLinked(Node* ear, double minX, double minY, double invSize, int pass) {
        if (!ear) return;
        if (!pass && invSize != 0) indexCurve(ear, minX, minY, invSize);
        Node* stop = ear;
        while (ear->prev != ear->next) {
            Node* prev = ear->prev;
            Node* next = ear->next;
            if (invSize != 0 ? isEarHashed(ear, minX, minY, invSize) : isEar(ear)) {
                triangles_.insert(triangles_.end(), {prev->i, ear->i, next->i});
                removeNode(ear);
                ear = next->next;
                stop = next->next;
                continue;
            }
            ear = next;
            if (ear == stop) {
                if (!pass) {
                    earcutLinked(filterPoints(ear), minX, minY, invSize, 1);
                } else if (pass == 1) {
                    ear = cureLocalIntersections(filterPoints(ear));
                    earcutLinked(ear, minX, minY, invSize, 2);
                } else if (pass == 2) {
                    splitEarcut(ear, minX, minY, invSize);
                }
                break;
            }
        }
    }

    static bool isEar(Node* ear) {
        const Node* a = ear->prev;
        const Node* b = ear;
        const Node* c = ear->next;
        if (area(a, b, c) >= 0) return false;
        const double ax = a->x, bx = b->x, cx = c->x, ay = a->y, by = b->y, cy = c->y;
        const double x0 = std::min({ax, bx, cx}), y0 = std::min({ay, by, cy});
        const double x1 = std::max({ax, bx, cx}), y1 = std::max({ay, by, cy});
        const Node* p = c->next;
        while (p != a) {
            if (p->x >= x0 && p->x <= x1 && p->y >= y0 && p->y <= y1 &&
                pointInTriangleExceptFirst(ax, ay, bx, by, cx, cy, p->x, p->y) && area(p->prev, p, p->next) >= 0)
                return false;
            p = p->next;
        }
        return true;
    }

    static bool isEarHashed(Node* ear, double minX, double minY, double invSize) {
        const Node* a = ear->prev;
        const Node* b = ear;
        const Node* c = ear->next;
        if (area(a, b, c) >= 0) return false;
        const double ax = a->x, bx = b->x, cx = c->x, ay = a->y, by = b->y, cy = c->y;
        const double x0 = std::min({ax, bx, cx}), y0 = std::min({ay, by, cy});
        const double x1 = std::max({ax, bx, cx}), y1 = std::max({ay, by, cy});
        const int32_t minZ = zOrder(x0, y0, minX, minY, invSize);
        const int32_t maxZ = zOrder(x1, y1, minX, minY, invSize);
        const Node* p = ear->prevZ;
        const Node* n = ear->nextZ;
        const auto blocks = [&](const Node* q) {
            return q->x >= x0 && q->x <= x1 && q->y >= y0 && q->y <= y1 && q != a && q != c &&
                   pointInTriangleExceptFirst(ax, ay, bx, by, cx, cy, q->x, q->y) && area(q->prev, q, q->next) >= 0;
        };
        while (p && p->z >= minZ && n && n->z <= maxZ) {
            if (blocks(p)) return false;
            p = p->prevZ;
            if (blocks(n)) return false;
            n = n->nextZ;
        }
        while (p && p->z >= minZ) {
            if (blocks(p)) return false;
            p = p->prevZ;
        }
        while (n && n->z <= maxZ) {
            if (blocks(n)) return false;
            n = n->nextZ;
        }
        return true;
    }

    Node* cureLocalIntersections(Node* start) {
        Node* p = start;
        do {
            Node* a = p->prev;
            Node* b = p->next->next;
            if (!equals(a, b) && intersects(a, p, p->next, b) && locallyInside(a, b) && locallyInside(b, a)) {
                triangles_.insert(triangles_.end(), {a->i, p->i, b->i});
                removeNode(p);
                removeNode(p->next);
                p = start = b;
            }
            p = p->next;
        } while (p != start);
        return filterPoints(p);
    }

    void splitEarcut(Node* start, double minX, double minY, double invSize) {
        Node* a = start;
        do {
            Node* b = a->next->next;
            while (b != a->prev) {
                if (a->i != b->i && isValidDiagonal(a, b)) {
                    Node* c = splitPolygon(a, b);
                    a = filterPoints(a, a->next);
                    c = filterPoints(c, c->next);
                    earcutLinked(a, minX, minY, invSize, 0);
                    earcutLinked(c, minX, minY, invSize, 0);
                    return;
                }
                b = b->next;
            }
            a = a->next;
        } while (a != start);
    }

    Node* eliminateHoles(const std::vector<uint32_t>& holeIndices, Node* outerNode) {
        std::vector<Node*> queue;
        for (size_t i = 0, len = holeIndices.size(); i < len; ++i) {
            const size_t start = size_t(holeIndices[i]) * 2;
            const size_t end = i < len - 1 ? size_t(holeIndices[i + 1]) * 2 : data_.size();
            Node* list = linkedList(start, end, false);
            if (!list) throw std::invalid_argument("TN_EARCUT_EMPTY_HOLE: a hole has no points");  // three throws too
            if (list == list->next) list->steiner = true;
            queue.push_back(getLeftmost(list));
        }
        // Array.prototype.sort is stable; a NaN comparison counts as not-less, as it does there.
        std::stable_sort(queue.begin(), queue.end(), [](const Node* a, const Node* b) { return compareXYSlope(a, b) < 0; });
        for (Node* hole : queue) outerNode = eliminateHole(hole, outerNode);
        return outerNode;
    }

    static double compareXYSlope(const Node* a, const Node* b) {
        double result = a->x - b->x;
        if (result == 0) {
            result = a->y - b->y;
            if (result == 0) {
                const double aSlope = (a->next->y - a->y) / (a->next->x - a->x);
                const double bSlope = (b->next->y - b->y) / (b->next->x - b->x);
                result = aSlope - bSlope;
            }
        }
        return result;
    }

    Node* eliminateHole(Node* hole, Node* outerNode) {
        Node* bridge = findHoleBridge(hole, outerNode);
        if (!bridge) return outerNode;
        Node* bridgeReverse = splitPolygon(bridge, hole);
        filterPoints(bridgeReverse, bridgeReverse->next);
        return filterPoints(bridge, bridge->next);
    }

    static Node* findHoleBridge(Node* hole, Node* outerNode) {
        Node* p = outerNode;
        const double hx = hole->x;
        const double hy = hole->y;
        double qx = -std::numeric_limits<double>::infinity();
        Node* m = nullptr;
        if (equals(hole, p)) return p;
        do {
            if (equals(hole, p->next)) return p->next;
            if (hy <= p->y && hy >= p->next->y && p->next->y != p->y) {
                const double x = p->x + (hy - p->y) * (p->next->x - p->x) / (p->next->y - p->y);
                if (x <= hx && x > qx) {
                    qx = x;
                    m = p->x < p->next->x ? p : p->next;
                    if (x == hx) return m;
                }
            }
            p = p->next;
        } while (p != outerNode);
        if (!m) return nullptr;
        Node* stop = m;
        const double mx = m->x;
        const double my = m->y;
        double tanMin = std::numeric_limits<double>::infinity();
        p = m;
        do {
            if (hx >= p->x && p->x >= mx && hx != p->x &&
                pointInTriangle(hy < my ? hx : qx, hy, mx, my, hy < my ? qx : hx, hy, p->x, p->y)) {
                const double tan = std::abs(hy - p->y) / (hx - p->x);
                if (locallyInside(p, hole) &&
                    (tan < tanMin || (tan == tanMin && (p->x > m->x || (p->x == m->x && sectorContainsSector(m, p)))))) {
                    m = p;
                    tanMin = tan;
                }
            }
            p = p->next;
        } while (p != stop);
        return m;
    }

    static bool sectorContainsSector(const Node* m, const Node* p) {
        return area(m->prev, m, p->prev) < 0 && area(p->next, m, m->next) < 0;
    }

    static void indexCurve(Node* start, double minX, double minY, double invSize) {
        Node* p = start;
        do {
            if (p->z == 0) p->z = zOrder(p->x, p->y, minX, minY, invSize);
            p->prevZ = p->prev;
            p->nextZ = p->next;
            p = p->next;
        } while (p != start);
        p->prevZ->nextZ = nullptr;
        p->prevZ = nullptr;
        sortLinked(p);
    }

    static Node* sortLinked(Node* list) {
        int numMerges;
        int inSize = 1;
        do {
            Node* p = list;
            Node* e;
            list = nullptr;
            Node* tail = nullptr;
            numMerges = 0;
            while (p) {
                numMerges++;
                Node* q = p;
                int pSize = 0;
                for (int i = 0; i < inSize; i++) {
                    pSize++;
                    q = q->nextZ;
                    if (!q) break;
                }
                int qSize = inSize;
                while (pSize > 0 || (qSize > 0 && q)) {
                    if (pSize != 0 && (qSize == 0 || !q || p->z <= q->z)) {
                        e = p;
                        p = p->nextZ;
                        pSize--;
                    } else {
                        e = q;
                        q = q->nextZ;
                        qSize--;
                    }
                    if (tail) tail->nextZ = e;
                    else list = e;
                    e->prevZ = tail;
                    tail = e;
                }
                p = q;
            }
            tail->nextZ = nullptr;
            inSize *= 2;
        } while (numMerges > 1);
        return list;
    }

    static int32_t zOrder(double fx, double fy, double minX, double minY, double invSize) {
        auto x = static_cast<uint32_t>(toInt32((fx - minX) * invSize));
        auto y = static_cast<uint32_t>(toInt32((fy - minY) * invSize));
        x = (x | (x << 8)) & 0x00FF00FFu;
        x = (x | (x << 4)) & 0x0F0F0F0Fu;
        x = (x | (x << 2)) & 0x33333333u;
        x = (x | (x << 1)) & 0x55555555u;
        y = (y | (y << 8)) & 0x00FF00FFu;
        y = (y | (y << 4)) & 0x0F0F0F0Fu;
        y = (y | (y << 2)) & 0x33333333u;
        y = (y | (y << 1)) & 0x55555555u;
        return static_cast<int32_t>(x | (y << 1));
    }

    static Node* getLeftmost(Node* start) {
        Node* p = start;
        Node* leftmost = start;
        do {
            if (p->x < leftmost->x || (p->x == leftmost->x && p->y < leftmost->y)) leftmost = p;
            p = p->next;
        } while (p != start);
        return leftmost;
    }

    static bool pointInTriangle(double ax, double ay, double bx, double by, double cx, double cy, double px, double py) {
        return (cx - px) * (ay - py) >= (ax - px) * (cy - py) && (ax - px) * (by - py) >= (bx - px) * (ay - py) &&
               (bx - px) * (cy - py) >= (cx - px) * (by - py);
    }

    static bool pointInTriangleExceptFirst(double ax, double ay, double bx, double by, double cx, double cy, double px,
                                           double py) {
        return !(ax == px && ay == py) && pointInTriangle(ax, ay, bx, by, cx, cy, px, py);
    }

    static bool isValidDiagonal(const Node* a, const Node* b) {
        return a->next->i != b->i && a->prev->i != b->i && !intersectsPolygon(a, b) &&
               ((locallyInside(a, b) && locallyInside(b, a) && middleInside(a, b) &&
                 (truthy(area(a->prev, a, b->prev)) || truthy(area(a, b->prev, b)))) ||
                (equals(a, b) && area(a->prev, a, a->next) > 0 && area(b->prev, b, b->next) > 0));
    }

    static bool truthy(double v) { return v != 0 && !std::isnan(v); }

    static double area(const Node* p, const Node* q, const Node* r) {
        return (q->y - p->y) * (r->x - q->x) - (q->x - p->x) * (r->y - q->y);
    }

    static bool equals(const Node* p1, const Node* p2) { return p1->x == p2->x && p1->y == p2->y; }

    static int sign(double num) { return num > 0 ? 1 : num < 0 ? -1 : 0; }

    static bool onSegment(const Node* p, const Node* q, const Node* r) {
        return q->x <= std::max(p->x, r->x) && q->x >= std::min(p->x, r->x) && q->y <= std::max(p->y, r->y) &&
               q->y >= std::min(p->y, r->y);
    }

    static bool intersects(const Node* p1, const Node* q1, const Node* p2, const Node* q2) {
        const int o1 = sign(area(p1, q1, p2));
        const int o2 = sign(area(p1, q1, q2));
        const int o3 = sign(area(p2, q2, p1));
        const int o4 = sign(area(p2, q2, q1));
        if (o1 != o2 && o3 != o4) return true;
        if (o1 == 0 && onSegment(p1, p2, q1)) return true;
        if (o2 == 0 && onSegment(p1, q2, q1)) return true;
        if (o3 == 0 && onSegment(p2, p1, q2)) return true;
        if (o4 == 0 && onSegment(p2, q1, q2)) return true;
        return false;
    }

    static bool intersectsPolygon(const Node* a, const Node* b) {
        const Node* p = a;
        do {
            if (p->i != a->i && p->next->i != a->i && p->i != b->i && p->next->i != b->i && intersects(p, p->next, a, b))
                return true;
            p = p->next;
        } while (p != a);
        return false;
    }

    static bool locallyInside(const Node* a, const Node* b) {
        return area(a->prev, a, a->next) < 0 ? area(a, b, a->next) >= 0 && area(a, a->prev, b) >= 0
                                             : area(a, b, a->prev) < 0 || area(a, a->next, b) < 0;
    }

    static bool middleInside(const Node* a, const Node* b) {
        const Node* p = a;
        bool inside = false;
        const double px = (a->x + b->x) / 2;
        const double py = (a->y + b->y) / 2;
        do {
            if (((p->y > py) != (p->next->y > py)) && p->next->y != p->y &&
                (px < (p->next->x - p->x) * (py - p->y) / (p->next->y - p->y) + p->x))
                inside = !inside;
            p = p->next;
        } while (p != a);
        return inside;
    }

    Node* splitPolygon(Node* a, Node* b) {
        Node* a2 = createNode(a->i, a->x, a->y);
        Node* b2 = createNode(b->i, b->x, b->y);
        Node* an = a->next;
        Node* bp = b->prev;
        a->next = b;
        b->prev = a;
        a2->next = an;
        an->prev = a2;
        b2->next = a2;
        a2->prev = b2;
        bp->next = b2;
        b2->prev = bp;
        return b2;
    }

    Node* insertNode(uint32_t i, double x, double y, Node* last) {
        Node* p = createNode(i, x, y);
        if (!last) {
            p->prev = p;
            p->next = p;
        } else {
            p->next = last->next;
            p->prev = last;
            last->next->prev = p;
            last->next = p;
        }
        return p;
    }

    static void removeNode(Node* p) {
        p->next->prev = p->prev;
        p->prev->next = p->next;
        if (p->prevZ) p->prevZ->nextZ = p->nextZ;
        if (p->nextZ) p->nextZ->prevZ = p->prevZ;
    }

    Node* createNode(uint32_t i, double x, double y) {
        nodes_.push_back(Node{i, x, y});
        return &nodes_.back();
    }
};

void removeDupEndPts(std::vector<Vector2>& points) {
    const size_t l = points.size();
    if (l > 2 && points[l - 1].equals(points[0])) points.pop_back();
}

}  // namespace

std::vector<uint32_t> earcut(const std::vector<double>& data, const std::vector<uint32_t>& holeIndices) {
    return Earcut(data).run(holeIndices);
}

namespace ShapeUtils {

double area(const std::vector<Vector2>& contour) {
    const size_t n = contour.size();
    double a = 0.0;
    for (size_t p = n - 1, q = 0; q < n; p = q++) a += contour[p].x * contour[q].y - contour[q].x * contour[p].y;
    return a * 0.5;
}

bool isClockWise(const std::vector<Vector2>& pts) { return area(pts) < 0; }

std::vector<std::array<uint32_t, 3>> triangulateShape(std::vector<Vector2>& contour,
                                                      std::vector<std::vector<Vector2>>& holes) {
    std::vector<double> vertices;
    std::vector<uint32_t> holeIndices;
    removeDupEndPts(contour);
    for (const Vector2& v : contour) vertices.insert(vertices.end(), {v.x, v.y});
    auto holeIndex = static_cast<uint32_t>(contour.size());
    for (auto& hole : holes) removeDupEndPts(hole);
    for (const auto& hole : holes) {
        holeIndices.push_back(holeIndex);
        holeIndex += static_cast<uint32_t>(hole.size());
        for (const Vector2& v : hole) vertices.insert(vertices.end(), {v.x, v.y});
    }
    const std::vector<uint32_t> triangles = earcut(vertices, holeIndices);
    std::vector<std::array<uint32_t, 3>> faces;
    for (size_t i = 0; i + 2 < triangles.size(); i += 3) faces.push_back({triangles[i], triangles[i + 1], triangles[i + 2]});
    return faces;
}

}  // namespace ShapeUtils

}  // namespace tn::engine
