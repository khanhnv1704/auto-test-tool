import Link from 'next/link';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';

export default function Home() {
  return (
    <main className="mx-auto w-full max-w-md p-4 sm:p-6">
      <Card className="shadow-sm">
        <CardContent className="flex flex-col items-center gap-4 py-10 text-center">
          <h1 className="text-xl font-semibold">Demo Sign-up App</h1>
          <p className="text-sm text-muted-foreground">
            A small demo app used as the target for AI Auto Test.
          </p>
          <Button asChild className="w-full">
            <Link href="/customer-signup">Go to the customer sign-up form</Link>
          </Button>
        </CardContent>
      </Card>
    </main>
  );
}
