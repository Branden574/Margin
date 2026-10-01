import type { Annotation } from '@margin/core';
import { bounds, pathData } from './model';

export function AnnotationGraphic({
  annotation: a,
  selected = false,
}: {
  annotation: Annotation;
  selected?: boolean;
}) {
  const b = bounds(a);
  let graphic;
  if (a.type === 'text')
    graphic = (
      <text
        x={a.x}
        y={a.y + 16}
        fill={a.color}
        fontSize="16"
        fontFamily="Arial, sans-serif"
        transform={`rotate(${a.rotation ?? 0} ${a.x} ${a.y})`}
      >
        {(a.text ?? '').split('\n').map((line, i) => (
          <tspan key={i} x={a.x} dy={i ? 21 : 0}>
            {line || ' '}
          </tspan>
        ))}
      </text>
    );
  else if (a.type === 'comment')
    graphic = (
      <g>
        <rect x={a.x} y={a.y} width="24" height="24" rx="9" fill={a.color} />
        <text
          x={a.x + 12}
          y={a.y + 17}
          textAnchor="middle"
          fill="white"
          fontSize="15"
          fontWeight="600"
        >
          !
        </text>
      </g>
    );
  else if (a.points?.length)
    graphic = (
      <path
        d={pathData(a.points) + (a.points.length === 1 ? ` l 0.1 0` : '')}
        fill="none"
        stroke={a.color}
        strokeWidth={a.strokeWidth}
        strokeLinecap="round"
        strokeLinejoin="round"
        opacity={a.opacity}
      />
    );
  else if (a.type === 'ellipse')
    graphic = (
      <ellipse
        cx={a.x + (a.width ?? 0) / 2}
        cy={a.y + (a.height ?? 0) / 2}
        rx={(a.width ?? 0) / 2}
        ry={(a.height ?? 0) / 2}
        fill="none"
        stroke={a.color}
        strokeWidth={a.strokeWidth}
      />
    );
  else
    graphic = (
      <rect
        x={a.x}
        y={a.y}
        width={a.width}
        height={a.height}
        rx={a.type === 'highlight' ? 2 : 0}
        fill={a.type === 'highlight' ? a.color : 'none'}
        stroke={a.type === 'highlight' ? 'none' : a.color}
        strokeWidth={a.strokeWidth}
        opacity={a.opacity}
      />
    );
  return (
    <g>
      {graphic}
      {selected ? (
        <rect
          x={b.x - 5}
          y={b.y - 5}
          width={b.width + 10}
          height={b.height + 10}
          fill="none"
          stroke="#b85d3c"
          strokeWidth="1"
          strokeDasharray="4 3"
        />
      ) : null}
    </g>
  );
}
