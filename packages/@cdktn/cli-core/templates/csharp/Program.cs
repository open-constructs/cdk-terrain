using System;
using Constructs;
using Io.Cdktn;

namespace MyCompany.MyApp
{
    class Program
    {
        public static void Main(string[] args)
        {
            App app = new App();
            new MainStack(app, "{{ $base }}");
            app.Synth();
            Console.WriteLine("App synth complete");
        }
    }
}